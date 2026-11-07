package com.mobhunter.agent

import org.junit.Assert.assertEquals
import org.junit.Test

/** Same cases as tests/tracking.test.ts — the two implementations must agree. */
class TrackingTest {
    private val now = 1_800_000_000_000L

    @Test fun activeTrackingUsesTheChosenInterval() {
        assertEquals(60_000L, Tracking.lostFixIntervalMs(60, now + 3_600_000, now, 80))
        assertEquals(120_000L, Tracking.lostFixIntervalMs(120, now + 3_600_000, now, null))
    }

    @Test fun clampsToSaneBounds() {
        assertEquals(60_000L, Tracking.lostFixIntervalMs(5, now + 1000, now, 80))
        assertEquals(300_000L, Tracking.lostFixIntervalMs(900, now + 1000, now, 80))
    }

    @Test fun fallsBackToFiveMinutesWhenTrackingEndsOrIsAbsent() {
        assertEquals(300_000L, Tracking.lostFixIntervalMs(60, now - 1, now, 80))
        assertEquals(300_000L, Tracking.lostFixIntervalMs(0, 0, now, 80))
    }

    @Test fun lowBatterySlowsToFiveMinutes() {
        assertEquals(300_000L, Tracking.lostFixIntervalMs(60, now + 3_600_000, now, 14))
        assertEquals(60_000L, Tracking.lostFixIntervalMs(60, now + 3_600_000, now, 15))
    }
}
