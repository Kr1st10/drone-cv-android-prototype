package ru.university.dronecv.camera

import org.junit.Assert.assertEquals
import org.junit.Test

class FrameOffsetTest {
    @Test fun aboveAndBelowCenterPreserveBothAxes() {
        val above = frameOffset(0.5, 0.25)
        val below = frameOffset(0.5, 0.75)
        assertEquals(0.0, above.first, 0.0001)
        assertEquals(-25.0, above.second, 0.0001)
        assertEquals(0.0, below.first, 0.0001)
        assertEquals(25.0, below.second, 0.0001)
    }
}
