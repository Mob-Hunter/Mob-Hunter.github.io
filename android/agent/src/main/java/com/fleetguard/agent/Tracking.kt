package com.fleetguard.agent

import java.text.DateFormat
import java.util.Date

/** Lost Mode cadence and the employee-facing notice. Mirrors src/core/tracking.ts. */
object Tracking {
    const val LOST_MODE_DEFAULT_MS = 5 * 60_000L

    /**
     * Active tracking: the chosen interval (60–300 s) until [until]; otherwise every 5 minutes.
     * Battery below 15%: never more often than every 5 minutes, so the phone stays findable for longer.
     */
    fun lostFixIntervalMs(intervalSec: Int, until: Long, now: Long, batteryLevel: Int?): Long {
        val active = intervalSec > 0 && now < until
        val ms = if (active) intervalSec.coerceIn(60, 300) * 1000L else LOST_MODE_DEFAULT_MS
        return if (batteryLevel != null && batteryLevel < 15) maxOf(ms, LOST_MODE_DEFAULT_MS) else ms
    }

    fun noticeText(c: Config, ticket: String?): String {
        val why = c.incidentKind?.let { "reported $it" } ?: "put in Lost Mode"
        val ref = ticket?.takeIf { it.isNotBlank() && it != "—" }?.let { " (ticket $it)" } ?: ""
        return if (c.trackingActive) {
            val until = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(c.trackingUntil))
            "This phone was $why$ref. Your organisation is tracking it every ${c.trackingIntervalSec / 60} min until $until."
        } else {
            "This phone was $why$ref. Its location is shared every 5 minutes until Lost Mode ends."
        }
    }
}
