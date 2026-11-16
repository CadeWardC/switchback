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

func TestCleanJPEG(t *testing.T) {
	seg := func(marker byte, body string) []byte {
		return append([]byte{0xFF, marker, byte((len(body) + 2) >> 8), byte(len(body) + 2)}, body...)
	}
	// what an iPhone writes: JFIF, then EXIF with the orientation (here 6, little-endian) and more
	exif := "Exif\x00\x00II*\x00\x08\x00\x00\x00\x02\x00\x1a\x01\x05\x00\x01\x00\x00\x00\x00\x00\x00\x00\x12\x01\x03\x00\x01\x00\x00\x00\x06\x00\x00\x00\x00\x00\x00\x00"
	sof := "\x08\x05\x35\x03\xe8\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00"
	tail := append(seg(0xDA, "\x03\x01\x00\x02\x00\x03\x00\x00\x3f\x00"), 0x12, 0x34, 0xFF, 0xD9)
	build := func(parts ...[]byte) []byte {
		out := []byte{0xFF, 0xD8}
		for _, p := range parts {
			out = append(out, p...)
		}
		return append(out, tail...)
	}
	jfif, icc := seg(0xE0, "JFIF\x00\x01\x01\x00\x00\x48\x00\x48\x00\x00"), seg(0xE2, "ICC_PROFILE\x00\x01\x01abc")
	in := build(jfif, seg(0xE1, exif), seg(0xE1, "http://ns.adobe.com/xap/1.0/\x00<x/>"), icc, seg(0xED, "Photoshop 3.0\x00"), seg(0xFE, "hi"), seg(0xC0, sof))
	got, err := CleanJPEG(in)
	if err != nil {
		t.Fatal(err)
	}
	turned := seg(0xE1, "Exif\x00\x00MM\x00*\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00\x06\x00\x00\x00\x00\x00\x00")
	if want := build(jfif, turned, icc, seg(0xC0, sof)); string(got) != string(want) {
		t.Fatalf("cleaned\n got %q\nwant %q", got, want)
	}
	info, err := Sniff(got)
	if err != nil || info.Width != 1000 || info.Height != 1333 || exifOrientation(got[len(jfif)+2+4+6:]) != 6 {
		t.Fatalf("after cleaning: %+v %v", info, err)
	}
	// upright (or no orientation): no EXIF at all is left
	upright := build(jfif, seg(0xE1, "Exif\x00\x00MM\x00*\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00\x01\x00\x00\x00\x00\x00\x00"), seg(0xC0, sof))
	if got, err = CleanJPEG(upright); err != nil || string(got) != string(build(jfif, seg(0xC0, sof))) {
		t.Fatalf("upright: %q %v", got, err)
	}
	if _, err := CleanJPEG(in[:40]); err == nil {
		t.Fatal("a cut-off file was accepted")
	}
}
