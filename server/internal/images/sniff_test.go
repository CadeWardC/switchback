package images

import (
	"encoding/binary"
	"testing"
)

func bx(typ string, body ...[]byte) []byte {
	n := 8
	for _, b := range body {
		n += len(b)
	}
	out := make([]byte, 8, n)
	binary.BigEndian.PutUint32(out, uint32(n))
	copy(out[4:], typ)
	for _, b := range body {
		out = append(out, b...)
	}
	return out
}

func u32(v ...uint32) []byte {
	out := make([]byte, 4*len(v))
	for i, x := range v {
		binary.BigEndian.PutUint32(out[4*i:], x)
	}
	return out
}

// heicFile builds the boxes a HEIC from ImageIO has: a 512×512 tile size and the full picture size, and optionally
// an Exif item.
func heicFile(w, h uint32, exif bool) []byte {
	infe := func(id uint16, typ string) []byte {
		return bx("infe", []byte{2, 0, 0, 0}, []byte{byte(id >> 8), byte(id)}, []byte{0, 0}, []byte(typ), []byte{0})
	}
	items := [][]byte{infe(1, "hvc1")}
	if exif {
		items = append(items, infe(2, "Exif"))
	}
	iinf := bx("iinf", append([]byte{0, 0, 0, 0, 0, byte(len(items))}, concat(items)...))
	ipco := bx("ipco", bx("ispe", u32(0, 512, 512)), bx("ispe", u32(0, w, h)))
	meta := bx("meta", []byte{0, 0, 0, 0}, bx("hdlr", u32(0, 0), []byte("pict")), iinf, bx("iprp", ipco))
	out := bx("ftyp", []byte("heic"), u32(0), []byte("mif1heic"))
	out = append(out, meta...)
	return append(out, bx("mdat", []byte{1, 2, 3})...)
}

func concat(bs [][]byte) []byte {
	var out []byte
	for _, b := range bs {
		out = append(out, b...)
	}
	return out
}

func TestHEIC(t *testing.T) {
	info, err := Sniff(heicFile(1000, 1333, false))
	if err != nil || info.Ext != "heic" || info.Width != 1000 || info.Height != 1333 || info.HasEXIF {
		t.Fatalf("got %+v %v", info, err)
	}
	info, err = Sniff(heicFile(1000, 1333, true))
	if err != nil || !info.HasEXIF {
		t.Fatalf("exif not found: %+v %v", info, err)
	}
}

func TestNotAPhoto(t *testing.T) {
	for _, b := range [][]byte{nil, []byte("hello world, not a photo"), bx("ftyp", []byte("avc1"))} {
		if _, err := Sniff(b); err == nil {
			t.Fatalf("accepted %q", b)
		}
	}
}
