package com.cadewardc.switchback.core

import kotlin.math.max

enum class Difficulty(val title: String, val colorHex: String) {
    EASY("Easy", "#2E9E5B"),
    MODERATE("Moderate", "#2B7FD9"),
    HARD("Hard", "#D9482B"),
    VERY_HARD("Very hard", "#7B4BC9");

    companion object {
        fun harder(a: Difficulty, b: Difficulty): Difficulty = if (a.ordinal >= b.ordinal) a else b
    }
}

/** Elevation along a line: distances from the start (m) and heights (m). */
class ElevationProfile(
    val distances: DoubleArray,
    val elevations: DoubleArray,
    /** Wiggles smaller than this many metres are ignored when adding up the climb. */
    threshold: Double = 2.0,
) {
    var gain: Double = 0.0
    var loss: Double = 0.0
    var minElevation: Double = 0.0
    var maxElevation: Double = 0.0

    init {
        if (elevations.isNotEmpty()) {
            var ref = elevations[0]
            var lo = ref
            var hi = ref
            for (i in 1 until elevations.size) {
                val e = elevations[i]
                if (e - ref >= threshold) {
                    gain += e - ref
                    ref = e
                } else if (ref - e >= threshold) {
                    loss += ref - e
                    ref = e
                }
                if (e < lo) lo = e
                if (e > hi) hi = e
            }
            minElevation = lo
            maxElevation = hi
        }
    }

    val total: Double get() = if (distances.isEmpty()) 0.0 else distances[distances.size - 1]

    /** The height at a distance along the profile. */
    fun heightAt(d: Double): Double {
        if (elevations.isEmpty()) return 0.0
        if (d <= distances[0]) return elevations[0]
        if (d >= total) return elevations[elevations.size - 1]
        var i = distances.indexOfFirst { it >= d }
        if (i < 0) i = distances.size - 1
        if (i == 0 || distances[i] <= distances[i - 1]) return elevations[i]
        val t = (d - distances[i - 1]) / (distances[i] - distances[i - 1])
        return elevations[i - 1] + (elevations[i] - elevations[i - 1]) * t
    }

    fun toJson(): Map<String, Any?> = linkedMapOf(
        "distances" to distances.map { Math.rint(it) },
        "elevations" to elevations.map { Math.rint(it * 10) / 10 },
        "gain" to Math.rint(gain),
        "loss" to Math.rint(loss),
        "minElevation" to minElevation,
        "maxElevation" to maxElevation,
    )

    companion object {
        /** A profile as trail packs store it: {s: metres per step, p: (steps, metres) deltas, g, l, mn, mx}. */
        fun fromPacked(packed: Map<String, Any?>): ElevationProfile? {
            val s = packed.double("s") ?: return null
            val p = packed.string("p") ?: return null
            val ints = Polyline.decodeInts(p)
            if (ints.size < 4) return null
            val n = ints.size / 2
            val distances = DoubleArray(n)
            val elevations = DoubleArray(n)
            var step = 0
            var height = 0
            for (k in 0 until n) {
                step += ints[2 * k]
                height += ints[2 * k + 1]
                distances[k] = step * s
                elevations[k] = height.toDouble()
            }
            val profile = ElevationProfile(distances, elevations)
            // the totals come from finer samples than the chart points
            packed.double("g")?.let { profile.gain = it }
            packed.double("l")?.let { profile.loss = it }
            packed.double("mn")?.let { profile.minElevation = it }
            packed.double("mx")?.let { profile.maxElevation = it }
            return profile
        }

        /** A profile as this app saves it. */
        fun fromJson(o: Map<String, Any?>): ElevationProfile? {
            val d = o.array("distances")?.mapNotNull { it.asDouble() } ?: return null
            val e = o.array("elevations")?.mapNotNull { it.asDouble() } ?: return null
            if (d.size != e.size || d.isEmpty()) return null
            val profile = ElevationProfile(d.toDoubleArray(), e.toDoubleArray())
            o.double("gain")?.let { profile.gain = it }
            o.double("loss")?.let { profile.loss = it }
            o.double("minElevation")?.let { profile.minElevation = it }
            o.double("maxElevation")?.let { profile.maxElevation = it }
            return profile
        }
    }
}

/** A trail: from a trail file, drawn in the app ("planned"), or a recorded hike walked again. */
class Trail(
    val id: String,
    val name: String,
    /** osmRelation, osmWay, usfs, imported, recorded or planned. */
    val source: String,
    val osmId: Long?,
    /** Every line of the trail, as drawn on the map. */
    val segments: List<List<Coord>>,
    /** The main continuous line: used for the length, the elevation chart and following. */
    val path: List<Coord>,
    val length: Double,
    val tags: Map<String, String>,
    val profile: ElevationProfile?,
) {
    val start: Coord get() = path.firstOrNull() ?: segments.firstOrNull()?.firstOrNull() ?: Coord(0.0, 0.0)

    val bbox: BBox by lazy {
        BBox.of(segments.asSequence().flatten().asIterable()) ?: BBox(start.lat, start.lon, start.lat, start.lon)
    }

    val isLoop: Boolean
        get() {
            if (path.size < 2 || length <= 500) return false
            return Geo.distance(path.first(), path.last()) < max(150.0, length * 0.03)
        }

    /** A route drawn over a whole web of trails (several loops), not one walk. */
    val isNetwork: Boolean get() = tags["switchback:network"] == "yes"

    val routeTypeTitle: String get() = if (isNetwork) "Trail network" else if (isLoop) "Loop" else "One way"

    /** A path mapped in OpenStreetMap without a name. */
    val isUnnamed: Boolean get() = tags["switchback:unnamed"] == "yes"

    /**
     * Not a hiking trail as far as we can tell: official lists say it isn't for hikers, or it's on no official list
     * and nothing in the map says people hike it. Hidden unless "Informal trails" is on.
     */
    val isInformal: Boolean get() = tags["switchback:informal"] == "yes"

    /** An access trail, spur or connector: not a hike of its own. */
    val isSide: Boolean get() = tags["switchback:side"] == "yes"

    val isRoadWalk: Boolean get() = tags["switchback:roadwalk"] == "yes"

    /**
     * A hike to list: a loop, a trail with a trailhead, a trail an official list has, or part of a trail system.
     * Side trails, road walks, short fragments and unnamed lines aren't; they stay on the map. Trail files decide
     * (switchback:hike=no).
     */
    val isHike: Boolean get() = tags["switchback:hike"] != "no" && !isSide && !isInformal && !isUnnamed

    /** The park, forest or place the trail is in ("Rock Bridge Memorial State Park"). */
    val area: String? get() = tags["switchback:area"]?.takeIf { it.isNotEmpty() }

    /** The trail system this belongs to ("Cedar Creek Trail"). */
    val system: String? get() = tags["switchback:system"]

    val difficulty: Difficulty
        get() {
            val km = length / 1000
            val effort = km + (profile?.gain ?: 0.0) / 100
            var level = when {
                effort < 8 -> Difficulty.EASY
                effort < 16 -> Difficulty.MODERATE
                effort < 26 -> Difficulty.HARD
                else -> Difficulty.VERY_HARD
            }
            // Forest Service class 1 (minimally developed) trails are rough going
            if (tags["usfs:trail_class"]?.filter { it.isDigit() } == "1") level = Difficulty.harder(level, Difficulty.MODERATE)
            when (tags["sac_scale"]) {
                "mountain_hiking" -> level = Difficulty.harder(level, Difficulty.MODERATE)
                "demanding_mountain_hiking" -> level = Difficulty.harder(level, Difficulty.HARD)
                "alpine_hiking", "demanding_alpine_hiking", "difficult_alpine_hiking" -> level = Difficulty.VERY_HARD
            }
            return level
        }

    /** Naismith's rule at an easy pace: 4.5 km/h plus an hour for every 600 m of climb. Seconds. */
    val estimatedDuration: Double get() = (length / 1000 / 4.5 + (profile?.gain ?: 0.0) / 600) * 3600

    val summary: String? get() = tags["description"] ?: tags["description:en"] ?: tags["note"]

    val website: String? get() = tags["website"] ?: tags["url"] ?: tags["official:url"]

    fun renamed(newName: String): Trail = Trail(id, newName, source, osmId, segments, path, length, tags, profile)

    /** As this app saves it (the same shape trail files use, with the elevation written out in full). */
    fun toJson(): Map<String, Any?> {
        val o = linkedMapOf<String, Any?>("id" to id, "name" to name, "source" to source)
        if (osmId != null) o["osmId"] = osmId
        o["segments"] = segments.map { Polyline.encode(it) }
        val i = segments.indexOf(path)
        if (i >= 0) o["pathIndex"] = i else o["path"] = Polyline.encode(path)
        o["length"] = Math.rint(length * 10) / 10
        if (tags.isNotEmpty()) o["tags"] = tags
        if (profile != null) o["profile"] = profile.toJson()
        return o
    }

    companion object {
        /** A trail from a trail file or from this app's own files; null when it can't be read. */
        fun fromJson(o: Map<String, Any?>): Trail? {
            val id = o.string("id") ?: return null
            val name = o.string("name") ?: return null
            val segments = o.array("segments")?.mapNotNull { s -> (s as? String)?.let { Polyline.decode(it) } } ?: return null
            val index = o.long("pathIndex")?.toInt()
            val path = if (index != null && index in segments.indices) {
                segments[index]
            } else {
                o.string("path")?.let { Polyline.decode(it) } ?: segments.firstOrNull() ?: return null
            }
            val length = o.double("length") ?: return null
            val tags = LinkedHashMap<String, String>()
            o.obj("tags")?.forEach { (k, v) -> if (v is String) tags[k] = v }
            val profile = o.obj("profile")?.let { ElevationProfile.fromJson(it) }
                ?: o.obj("elev")?.let { ElevationProfile.fromPacked(it) }
            return Trail(id, name, o.string("source") ?: "imported", o.long("osmId"), segments, path, length, tags, profile)
        }

        /** A route drawn on the map by hand. */
        fun planned(id: String, name: String, points: List<Coord>): Trail =
            Trail(id, name, "planned", null, listOf(points), points, Geo.length(points), mapOf("switchback:planned" to "yes"), null)
    }
}

/** How the list of hikes is ordered. */
enum class TrailSort(val title: String) {
    CLOSEST("Closest"),
    SHORTEST("Shortest"),
    LONGEST("Longest"),
    LEAST_CLIMB("Least climb"),
    MOST_CLIMB("Most climb"),
}

object TrailLists {
    /**
     * What the map draws: everything, except informal trails unless they are switched on.
     */
    fun onMap(trails: List<Trail>, informal: Boolean): List<Trail> =
        if (informal) trails else trails.filter { !it.isInformal }

    /**
     * What the list shows: hikes, unless "List every trail" is on (then side trails, road walks, short pieces and
     * unnamed paths too). Informal trails only when they are switched on.
     */
    fun listed(
        trails: List<Trail>,
        everyTrail: Boolean,
        informal: Boolean,
        difficulties: Set<Difficulty>,
        sort: TrailSort,
        origin: Coord?,
    ): List<Trail> {
        var list = trails.filter { t ->
            (informal || !t.isInformal) &&
                (everyTrail || t.isHike || (informal && t.isInformal)) &&
                (difficulties.isEmpty() || t.difficulty in difficulties)
        }
        list = when (sort) {
            TrailSort.CLOSEST -> if (origin != null) list.sortedBy { Geo.distance(origin, it.start) } else list
            TrailSort.SHORTEST -> list.sortedBy { it.length }
            TrailSort.LONGEST -> list.sortedByDescending { it.length }
            TrailSort.LEAST_CLIMB -> list.sortedBy { it.profile?.gain ?: Double.POSITIVE_INFINITY }
            TrailSort.MOST_CLIMB -> list.sortedByDescending { it.profile?.gain ?: -1.0 }
        }
        return list
    }
}
