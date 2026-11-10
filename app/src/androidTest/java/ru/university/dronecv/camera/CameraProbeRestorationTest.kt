package ru.university.dronecv.camera

import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CameraProbeRestorationTest {
    @get:Rule val compose = createComposeRule()

    @Test fun restoresRequestWithoutRestoringRuntime() {
        val restoration = StateRestorationTester(compose)
        lateinit var probe: CameraProbeState
        restoration.setContent { probe = rememberCameraProbeState() }
        compose.runOnIdle {
            assertEquals(1f, probe.requestedZoom, 0f)
            assertNull(probe.physicalId)
            probe.requestedZoom = 2f
            probe.physicalId = "physical-test"
            probe.logicalId = "logical-test"
            probe.activePhysicalId = "active-test"
            probe.physicalIds = listOf("physical-test")
            probe.actualZoom = 2f
            probe.loading = true
            probe.warning = "old warning"
            probe.selectionEpoch = 7
        }
        restoration.emulateSavedInstanceStateRestore()
        compose.runOnIdle {
            assertEquals(2f, probe.requestedZoom, 0f)
            assertEquals("physical-test", probe.physicalId)
            assertNull(probe.logicalId)
            assertNull(probe.activePhysicalId)
            assertEquals(emptyList<String>(), probe.physicalIds)
            assertNull(probe.zoomRange)
            assertNull(probe.actualZoom)
            assertFalse(probe.loading)
            assertNull(probe.warning)
            assertEquals(0L, probe.selectionEpoch)
        }
    }
}
