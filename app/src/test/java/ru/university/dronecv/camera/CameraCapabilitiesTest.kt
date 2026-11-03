package ru.university.dronecv.camera

import org.junit.Assert.*
import org.junit.Test

class CameraCapabilitiesTest {
    @Test fun onlySupportedFiniteZoomCanBeRequested() {
        assertTrue(zoomRequest(5f, ZoomRange(1f, 10f)) is ZoomDecision.Request)
        assertTrue(zoomRequest(5f, ZoomRange(1f, 4f)) is ZoomDecision.Unavailable)
        assertTrue(zoomRequest(1f, null) is ZoomDecision.Unavailable)
        assertTrue(zoomRequest(Float.NaN, ZoomRange(1f, 4f)) is ZoomDecision.Unavailable)
    }
    @Test fun physicalSwitchIsNotInferredFromZoom() {
        assertTrue(sensorEvidence(null, setOf("a", "b")).contains("не подтверждён"))
        assertTrue(sensorEvidence("b", setOf("a", "b")).contains("сравнением"))
        assertTrue(sensorEvidence("x", setOf("a", "b")).contains("не найден"))
    }
}
