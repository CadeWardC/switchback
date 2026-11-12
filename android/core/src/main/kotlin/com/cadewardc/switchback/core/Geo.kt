package com.cadewardc.switchback.core

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/** A latitude/longitude pair. */
data class Coord(val lat: Double, val lon: Double)

/** A latitude/longitude box. */
data class BBox(val south: Double, val west: Double, val north: Double, val east: Double) {
    val center: Coord get() = Coord((south + north) / 2, (west + east) / 2)
    val latSpan: Double get() = north - south
    val lonSpan: Double get() = east - west

    fun contains(c: Coord): Boolean = c.lat in south..north && c.lon in west..east

    fun intersects(o: BBox): Boolean = !(o.west > east || o.east < west || o.south > north || o.north < south)

    fun expanded(byDegrees: Double): BBox =
        BBox(south - byDegrees, west - byDegrees, north + byDegrees, east + byDegrees)

    companion object {
        fun of(coords: Iterable<Coord>): BBox? {
            var s = Double.POSITIVE_INFINITY
            var n = Double.NEGATIVE_INFINITY
            var w = Double.POSITIVE_INFINITY
            var e = Double.NEGATIVE_INFINITY
            var any = false
            for (c in coords) {
                any = true
                s = min(s, c.lat); n = max(n, c.lat)
                w = min(w, c.lon); e = max(e, c.lon)
            }
            return if (any) BBox(s, w, n, e) else null
        }
    }
}

object Geo {
    const val EARTH_RADIUS = 6_371_000.0
    const val METERS_PER_DEGREE = 111_320.0

    /** Great-circle distance in metres. */
    fun distance(a: Coord, b: Coord): Double {
        val dLat = Math.toRadians(b.lat - a.lat)
        val dLon = Math.toRadians(b.lon - a.lon)
        val la1 = Math.toRadians(a.lat)
        val la2 = Math.toRadians(b.lat)
        val h = sin(dLat / 2) * sin(dLat / 2) + cos(la1) * cos(la2) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * EARTH_RADIUS * asin(min(1.0, sqrt(h)))
    }

    fun length(pts: List<Coord>): Double {
        var total = 0.0
        for (i in 1 until pts.size) total += distance(pts[i - 1], pts[i])
        return total
    }

    /** Distance from the start to each point. */
    fun cumulative(pts: List<Coord>): DoubleArray {
        val out = DoubleArray(pts.size)
        var total = 0.0
        for (i in pts.indices) {
            if (i > 0) total += distance(pts[i - 1], pts[i])
            out[i] = total
        }
        return out
    }

    class Projection(val distance: Double, val t: Double)

    /** Distance in metres from `p` to the segment a–b, and where along it (0…1) the closest point is. */
    fun project(p: Coord, a: Coord, b: Coord): Projection {
        val k = cos(Math.toRadians(p.lat)) * METERS_PER_DEGREE
        val ax = (a.lon - p.lon) * k
        val ay = (a.lat - p.lat) * METERS_PER_DEGREE
        val bx = (b.lon - p.lon) * k
        val by = (b.lat - p.lat) * METERS_PER_DEGREE
        val dx = bx - ax
        val dy = by - ay
        val len2 = dx * dx + dy * dy
        val t = if (len2 > 0) max(0.0, min(1.0, -(ax * dx + ay * dy) / len2)) else 0.0
        val x = ax + t * dx
        val y = ay + t * dy
        return Projection(sqrt(x * x + y * y), t)
    }

    /** Shortest distance in metres from `p` to any of the lines. */
    fun distanceToPath(p: Coord, segments: List<List<Coord>>): Double {
        var best = Double.POSITIVE_INFINITY
        for (seg in segments) {
            if (seg.size == 1) best = min(best, distance(p, seg[0]))
            for (i in 1 until seg.size) best = min(best, project(p, seg[i - 1], seg[i]).distance)
        }
        return best
    }

    class Located(val along: Double, val offset: Double)

    /** How far along the line the point closest to `p` is, and how far `p` is from the line. */
    fun locate(p: Coord, path: List<Coord>, cumulative: DoubleArray): Located? {
        if (path.size < 2 || cumulative.size != path.size) return null
        var best: Located? = null
        for (i in 1 until path.size) {
            val r = project(p, path[i - 1], path[i])
            if (best == null || r.distance < best.offset) {
                best = Located(cumulative[i - 1] + (cumulative[i] - cumulative[i - 1]) * r.t, r.distance)
            }
        }
        return best
    }

    /** Drops points that don't change the line's shape by more than `tolerance` metres (Douglas–Peucker). */
    fun simplify(pts: List<Coord>, tolerance: Double): List<Coord> {
        if (pts.size <= 2) return pts
        val keep = BooleanArray(pts.size)
        keep[0] = true
        keep[pts.size - 1] = true
        val stack = ArrayDeque<IntArray>()
        stack.addLast(intArrayOf(0, pts.size - 1))
        while (stack.isNotEmpty()) {
            val (a, b) = stack.removeLast()
            if (b <= a + 1) continue
            var maxD = 0.0
            var idx = a
            for (i in a + 1 until b) {
                val d = project(pts[i], pts[a], pts[b]).distance
                if (d > maxD) {
                    maxD = d
                    idx = i
                }
            }
            if (maxD > tolerance) {
                keep[idx] = true
                stack.addLast(intArrayOf(a, idx))
                stack.addLast(intArrayOf(idx, b))
            }
        }
        return pts.filterIndexed { i, _ -> keep[i] }
    }

    fun floorInt(v: Double): Int = floor(v).toInt()
}

/** Lines stored as encoded polylines (Google's format, 1e-5° ≈ 1 m). */
object Polyline {
    fun encode(coords: List<Coord>): String {
        val sb = StringBuilder(coords.size * 8)
        var pLat = 0L
        var pLon = 0L
        for (c in coords) {
            val lat = Math.round(c.lat * 1e5)
            val lon = Math.round(c.lon * 1e5)
            append(lat - pLat, sb)
            append(lon - pLon, sb)
            pLat = lat
            pLon = lon
        }
        return sb.toString()
    }

    /** Plain integers written in the same alphabet. */
    fun encodeInts(values: List<Int>): String {
        val sb = StringBuilder(values.size * 2)
        for (v in values) append(v.toLong(), sb)
        return sb.toString()
    }

    private fun append(v: Long, sb: StringBuilder) {
        var x = if (v < 0) (v shl 1).inv() else (v shl 1)
        while (x >= 0x20) {
            sb.append(((0x20L or (x and 0x1f)) + 63).toInt().toChar())
            x = x shr 5
        }
        sb.append((x + 63).toInt().toChar())
    }

    /** Plain integers written in the same alphabet (the elevation charts in trail packs). */
    fun decodeInts(s: String): IntArray {
        val out = IntArray(s.length)
        var n = 0
        var i = 0
        while (i < s.length) {
            var result = 0L
            var shift = 0
            var ended = false
            while (i < s.length) {
                val b = s[i].code - 63
                i++
                result = result or ((b and 0x1f).toLong() shl shift)
                shift += 5
                if (b < 0x20) {
                    ended = true
                    break
                }
            }
            if (!ended) break
            out[n++] = (if (result and 1L != 0L) (result shr 1).inv() else (result shr 1)).toInt()
        }
        return out.copyOf(n)
    }

    fun decode(s: String): List<Coord> {
        val ints = decodeInts(s)
        val out = ArrayList<Coord>(ints.size / 2)
        var lat = 0
        var lon = 0
        var i = 0
        while (i + 1 < ints.size) {
            lat += ints[i]
            lon += ints[i + 1]
            out.add(Coord(lat / 1e5, lon / 1e5))
            i += 2
        }
        return out
    }
}
