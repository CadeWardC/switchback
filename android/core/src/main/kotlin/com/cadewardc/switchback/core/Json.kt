package com.cadewardc.switchback.core

/**
 * A small JSON reader and writer, so this module needs no library and behaves the same on a phone and on a computer.
 * Objects are read as [Map]<String, Any?> (in file order), arrays as [List]<Any?>, numbers as [Long] when they are
 * whole and fit, otherwise [Double].
 */
object Json {
    class ParseException(message: String) : Exception(message)

    fun parse(text: String): Any? {
        val p = Parser(text)
        p.skipSpace()
        val v = p.value()
        p.skipSpace()
        if (p.i != text.length) throw ParseException("Unexpected text at ${p.i}")
        return v
    }

    /** The same, or null when the text is not JSON. */
    fun parseOrNull(text: String): Any? = try {
        parse(text)
    } catch (e: Exception) {
        null
    }

    fun write(value: Any?): String {
        val sb = StringBuilder()
        write(value, sb)
        return sb.toString()
    }

    private fun write(v: Any?, sb: StringBuilder) {
        when (v) {
            null -> sb.append("null")
            is String -> quote(v, sb)
            is Boolean -> sb.append(if (v) "true" else "false")
            is Int, is Long, is Short, is Byte -> sb.append(v.toString())
            is Number -> {
                val d = v.toDouble()
                if (d.isNaN() || d.isInfinite()) {
                    sb.append("null")
                } else if (d == Math.rint(d) && Math.abs(d) < 1e15) {
                    sb.append(d.toLong().toString())
                } else {
                    sb.append(d.toString())
                }
            }
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, x) in v) {
                    if (!first) sb.append(',')
                    first = false
                    quote(k.toString(), sb)
                    sb.append(':')
                    write(x, sb)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (x in v) {
                    if (!first) sb.append(',')
                    first = false
                    write(x, sb)
                }
                sb.append(']')
            }
            else -> quote(v.toString(), sb)
        }
    }

    private fun quote(s: String, sb: StringBuilder) {
        sb.append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c < ' ') sb.append(String.format("\\u%04x", c.code)) else sb.append(c)
            }
        }
        sb.append('"')
    }

    private class Parser(val s: String) {
        var i = 0

        fun skipSpace() {
            while (i < s.length) {
                val c = s[i]
                if (c == ' ' || c == '\n' || c == '\r' || c == '\t') i++ else break
            }
        }

        fun value(): Any? {
            if (i >= s.length) throw ParseException("Unexpected end")
            return when (val c = s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> word("true", true)
                'f' -> word("false", false)
                'n' -> word("null", null)
                else -> if (c == '-' || (c in '0'..'9')) num() else throw ParseException("Unexpected '$c' at $i")
            }
        }

        private fun word(w: String, v: Any?): Any? {
            if (!s.startsWith(w, i)) throw ParseException("Unexpected text at $i")
            i += w.length
            return v
        }

        private fun obj(): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>()
            i++
            skipSpace()
            if (i < s.length && s[i] == '}') {
                i++
                return out
            }
            while (true) {
                skipSpace()
                if (i >= s.length || s[i] != '"') throw ParseException("Expected a name at $i")
                val k = str()
                skipSpace()
                if (i >= s.length || s[i] != ':') throw ParseException("Expected ':' at $i")
                i++
                skipSpace()
                out[k] = value()
                skipSpace()
                if (i >= s.length) throw ParseException("Unexpected end")
                if (s[i] == ',') {
                    i++
                } else if (s[i] == '}') {
                    i++
                    return out
                } else {
                    throw ParseException("Expected ',' or '}' at $i")
                }
            }
        }

        private fun arr(): List<Any?> {
            val out = ArrayList<Any?>()
            i++
            skipSpace()
            if (i < s.length && s[i] == ']') {
                i++
                return out
            }
            while (true) {
                skipSpace()
                out.add(value())
                skipSpace()
                if (i >= s.length) throw ParseException("Unexpected end")
                if (s[i] == ',') {
                    i++
                } else if (s[i] == ']') {
                    i++
                    return out
                } else {
                    throw ParseException("Expected ',' or ']' at $i")
                }
            }
        }

        private fun str(): String {
            i++
            val start = i
            // most strings have no escapes: find the end and cut
            while (i < s.length) {
                val c = s[i]
                if (c == '"') {
                    val out = s.substring(start, i)
                    i++
                    return out
                }
                if (c == '\\') break
                i++
            }
            val sb = StringBuilder(s.substring(start, i))
            while (i < s.length) {
                val c = s[i++]
                if (c == '"') return sb.toString()
                if (c != '\\') {
                    sb.append(c)
                    continue
                }
                if (i >= s.length) break
                when (val e = s[i++]) {
                    'n' -> sb.append('\n')
                    't' -> sb.append('\t')
                    'r' -> sb.append('\r')
                    'b' -> sb.append('\b')
                    'f' -> sb.append('\u000C')
                    'u' -> {
                        if (i + 4 > s.length) throw ParseException("Bad \\u escape at $i")
                        sb.append(s.substring(i, i + 4).toInt(16).toChar())
                        i += 4
                    }
                    else -> sb.append(e)
                }
            }
            throw ParseException("Unterminated string")
        }

        private fun num(): Any {
            val start = i
            var whole = true
            if (s[i] == '-') i++
            while (i < s.length) {
                val c = s[i]
                if (c in '0'..'9') {
                    i++
                } else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
                    whole = false
                    i++
                } else {
                    break
                }
            }
            val t = s.substring(start, i)
            if (whole && t.length < 18) return t.toLong()
            return t.toDoubleOrNull() ?: throw ParseException("Bad number '$t'")
        }
    }
}

// Reading values out of parsed JSON without casts everywhere.

@Suppress("UNCHECKED_CAST")
fun Any?.asObject(): Map<String, Any?>? = this as? Map<String, Any?>

fun Any?.asArray(): List<Any?>? = this as? List<Any?>

fun Any?.asDouble(): Double? = (this as? Number)?.toDouble()

fun Any?.asLong(): Long? = (this as? Number)?.toLong()

fun Any?.asString(): String? = this as? String

fun Map<String, Any?>.string(key: String): String? = this[key] as? String

fun Map<String, Any?>.double(key: String): Double? = (this[key] as? Number)?.toDouble()

fun Map<String, Any?>.long(key: String): Long? = (this[key] as? Number)?.toLong()

fun Map<String, Any?>.bool(key: String): Boolean? = this[key] as? Boolean

fun Map<String, Any?>.obj(key: String): Map<String, Any?>? = this[key].asObject()

fun Map<String, Any?>.array(key: String): List<Any?>? = this[key].asArray()
