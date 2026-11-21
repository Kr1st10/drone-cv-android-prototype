package ru.university.dronecv.qnn

import org.junit.Assert.assertEquals
import org.junit.Test

class FrameScheduleTest {
    @Test
    fun fullRunHasExactlyFifteenMinutesOfSlots() {
        for (fps in SUSTAINED_RATES) {
            val schedule = FrameSchedule(fps)
            assertEquals(15 * 60 * fps, schedule.dueSlots(schedule.durationNs))
            assertEquals(schedule.slots, schedule.currentSlot(schedule.durationNs))
            assertEquals(60 * fps, schedule.dueSlots(60_000_000_000L))
        }
    }

    @Test
    fun expiredSlotsDoNotChangeTheFollowingInputOrder() {
        val schedule = FrameSchedule(3)
        assertEquals(333_333_334L, schedule.slotTimeNs(1))
        assertEquals(0, schedule.currentSlot(333_333_333L))
        assertEquals(1, schedule.currentSlot(333_333_334L))
        assertEquals(1, schedule.dueSlots(333_333_334L))
        assertEquals(2, schedule.dueSlots(333_333_335L))
        val afterSlowInference = schedule.currentSlot(1_900_000_000L)
        assertEquals(5, afterSlowInference)
        assertEquals(2, schedule.frameIndex(afterSlowInference, 3))
        assertEquals(0, schedule.frameIndex(afterSlowInference + 1, 3))
    }
}
