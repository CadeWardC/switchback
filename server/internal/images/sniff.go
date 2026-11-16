// Package images checks an uploaded photo without decoding it: that it really is HEIC or JPEG, how big it is, and
// that its metadata (EXIF, which holds the GPS position) was removed on the phone.
package images

import (
	"encoding/binary"
	"errors"
)

type Info struct {
	Ext    string // "heic" or "jpg"
	Width  int
	Height int
	// HasEXIF is true if the file still carries EXIF metadata (location, time, camera).
	HasEXIF bool
}

var ErrUnknown = errors.New("not a HEIC or JPEG photo")

func Sniff(b []byte) (Info, error) {
	if len(b) > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF {
		return jpeg(b)
	}
	if len(b) > 12 && string(b[4:8]) == "ftyp" {
		switch string(b[8:12]) {
		case "heic", "heix", "heim", "heis", "mif1", "msf1":
			return heic(b)
		}
	}
	return Info{}, ErrUnknown
}

func jpeg(b []byte) (Info, error) {
	info := Info{Ext: "jpg"}
	i := 2
	for i+4 <= len(b) {
		if b[i] != 0xFF {
			return info, ErrUnknown
		}
		marker := b[i+1]
		if marker == 0xFF { // fill byte
			i++
			continue
		}
		if marker == 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker == 0x01 {
			i += 2
			continue
		}
		n := int(binary.BigEndian.Uint16(b[i+2:]))
		if n < 2 || i+2+n > len(b) {
			return info, ErrUnknown
		}
		seg := b[i+4 : i+2+n]
		switch {
		case marker == 0xE1 && len(seg) >= 6 && string(seg[:6]) == "Exif\x00\x00":
			info.HasEXIF = true
		case marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC:
			if len(seg) >= 5 {
				info.Height = int(binary.BigEndian.Uint16(seg[1:]))
				info.Width = int(binary.BigEndian.Uint16(seg[3:]))
			}
		case marker == 0xDA: // image data starts: no more headers
			if info.Width == 0 {
				return info, ErrUnknown
			}
			return info, nil
		}
		i += 2 + n
	}
	if info.Width == 0 {
		return info, ErrUnknown
	}
	return info, nil
}

type box struct {
	typ  string
	body []byte
}

// boxes splits ISO-BMFF boxes.
func boxes(b []byte) []box {
	var out []box
	for len(b) >= 8 {
		size := uint64(binary.BigEndian.Uint32(b))
		typ := string(b[4:8])
		head := uint64(8)
		switch size {
		case 0:
			size = uint64(len(b))
		case 1:
			if len(b) < 16 {
				return out
			}
			size = binary.BigEndian.Uint64(b[8:])
			head = 16
		}
		if size < head || size > uint64(len(b)) {
			return out
		}
		out = append(out, box{typ, b[head:size]})
		b = b[size:]
	}
	return out
}

func heic(b []byte) (Info, error) {
	info := Info{Ext: "heic"}
	for _, top := range boxes(b) {
		if top.typ != "meta" || len(top.body) < 4 {
			continue
		}
		for _, m := range boxes(top.body[4:]) { // meta is a full box: skip version and flags
			switch m.typ {
			case "iinf":
				if hasExifItem(m.body) {
					info.HasEXIF = true
				}
			case "iprp":
				for _, p := range boxes(m.body) {
					if p.typ != "ipco" {
						continue
					}
					for _, prop := range boxes(p.body) {
						// the largest image spatial extent is the full picture (others are tiles or thumbnails)
						if prop.typ == "ispe" && len(prop.body) >= 12 {
							w := int(binary.BigEndian.Uint32(prop.body[4:]))
							h := int(binary.BigEndian.Uint32(prop.body[8:]))
							if w*h > info.Width*info.Height {
								info.Width, info.Height = w, h
							}
						}
					}
				}
			}
		}
	}
	if info.Width == 0 {
		return info, ErrUnknown
	}
	return info, nil
}

func hasExifItem(iinf []byte) bool {
	if len(iinf) < 6 {
		return false
	}
	rest := iinf[6:] // version, flags, 16-bit count
	if iinf[0] != 0 {
		if len(iinf) < 8 {
			return false
		}
		rest = iinf[8:] // 32-bit count
	}
	for _, e := range boxes(rest) {
		if e.typ != "infe" || len(e.body) < 4 {
			continue
		}
		v := e.body[0]
		var off int
		switch {
		case v == 2:
			off = 4 + 2 + 2 // version/flags, item id, protection index
		case v >= 3:
			off = 4 + 4 + 2
		default:
			continue
		}
		if len(e.body) >= off+4 && string(e.body[off:off+4]) == "Exif" {
			return true
		}
	}
	return false
}
