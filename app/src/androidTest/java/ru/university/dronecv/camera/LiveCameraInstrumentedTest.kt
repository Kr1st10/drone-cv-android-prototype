package ru.university.dronecv.camera

import android.Manifest
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.FileInputStream
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import ru.university.dronecv.MainActivity
import ru.university.dronecv.detection.DetectorWorker

/** Real app UI -> CameraX RGBA -> local model -> rendered result, with no fake detections.
 * Emulator results cover integration, not real-drone quality, physical alignment, or phone speed.
 */
@RunWith(AndroidJUnit4::class)
class LiveCameraInstrumentedTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Before fun grantCamera() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        assumeTrue("Camera hardware required", context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY))
        instrumentation.uiAutomation.executeShellCommand(
            "pm grant ${context.packageName} ${Manifest.permission.CAMERA}"
        ).use { FileInputStream(it.fileDescriptor).use { input -> input.readBytes() } }
    }

    private fun openAndStart() {
        compose.onNodeWithText("Камера").performClick()
        compose.onNodeWithText("Начать детекцию").performClick()
        awaitResult()
    }

    private fun awaitResult() {
        compose.waitUntil(90_000) { compose.onAllNodesWithTag("live-frame-ready").fetchSemanticsNodes().isNotEmpty() }
    }

    private fun drainNativeWork() {
        // Ordered after any native call and release. No sleeping and no fabricated FPS assertion.
        DetectorWorker.executor.submit {}.get(90, TimeUnit.SECONDS)
        compose.waitForIdle()
    }

    @Test fun cameraRunsRealModelAndStopClearsLateResults() {
        openAndStart()
        compose.onNodeWithTag("live-frame-ready").assertExists()
        compose.onNodeWithText("Остановить").performClick()
        drainNativeWork()
        compose.onNodeWithText("Детекция остановлена").assertExists()
        compose.onNodeWithTag("live-frame-ready").assertDoesNotExist()
        compose.onNodeWithText("Начать детекцию").performClick()
        awaitResult()
        // Switching to Photo disposes camera/model and retains the original photo entry point.
        compose.onNodeWithText("Фото").performClick()
        drainNativeWork()
        compose.onNodeWithTag("live-frame-ready").assertDoesNotExist()
        compose.onNodeWithText("Выбрать фото").assertExists()
    }

    @Test fun backgroundRecreationAndBothLandscapeDirectionsResumeInference() {
        openAndStart()
        compose.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
        drainNativeWork()
        compose.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
        awaitResult()
        for (orientation in listOf(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE,
            ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE)) {
            val oldRotation = compose.activity.window.decorView.display.rotation
            compose.activityRule.scenario.onActivity { it.requestedOrientation = orientation }
            compose.waitUntil(15_000) {
                compose.activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE &&
                    compose.activity.window.decorView.display.rotation != oldRotation
            }
            awaitResult()
        }
        compose.activityRule.scenario.recreate()
        awaitResult()
        compose.onNodeWithText("Остановить").performClick()
        compose.activityRule.scenario.recreate()
        drainNativeWork()
        compose.onNodeWithText("Детекция остановлена").assertExists()
        compose.onNodeWithTag("live-frame-ready").assertDoesNotExist()
        assertEquals(Configuration.ORIENTATION_LANDSCAPE, compose.activity.resources.configuration.orientation)
    }
}
