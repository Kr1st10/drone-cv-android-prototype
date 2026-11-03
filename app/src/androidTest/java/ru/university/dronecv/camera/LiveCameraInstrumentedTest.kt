package ru.university.dronecv.camera

import android.Manifest
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
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
        // Three consecutive results prove that showing statistics does not resize/rebind the preview.
        compose.waitUntil(90_000) {
            compose.onAllNodesWithTag("live-frame-ready").fetchSemanticsNodes().any { node ->
                val text = node.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }.orEmpty()
                val frames = Regex("кадров: ([0-9]+)").find(text)?.groupValues?.get(1)?.toLongOrNull() ?: 0
                frames >= 3
            }
        }
    }

    private fun drainNativeWork() {
        // Ordered after any native call and release. No sleeping and no fabricated FPS assertion.
        compose.waitForIdle() // Apply disposal before queueing the worker barrier.
        DetectorWorker.executor.submit {}.get(90, TimeUnit.SECONDS)
        compose.waitForIdle()
    }

    @Test fun cameraRunsRealModelAndStopClearsLateResults() {
        openAndStart()
        compose.onNodeWithTag("live-frame-ready").assertExists()
        compose.onNodeWithContentDescription("Порог уверенности детектора")
            .performSemanticsAction(SemanticsActions.SetProgress) { it(0.8f) }
        compose.onNodeWithText("Confidence: 80%").assertExists()
        awaitResult()
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
        compose.onNodeWithText("Камера").performClick()
        compose.onNodeWithText("Confidence: 80%").assertExists()
        compose.onNodeWithText("Начать детекцию").assertExists()
    }

    @Test fun diagnosticSessionIsInterruptedOnTabSwitchAndReportRemainsAvailable() {
        openAndStart()
        compose.onNodeWithTag("diagnostic-start").performScrollTo().performClick()
        compose.onNodeWithTag("diagnostic-stop").assertExists()
        compose.onNodeWithText("Фото").performClick()
        drainNativeWork()
        compose.onNodeWithText("Камера").performClick()
        compose.onNodeWithTag("diagnostic-export").performScrollTo().assertExists()
        compose.onNodeWithText("Прервана:", substring = true).assertExists()
    }

    @Test fun backgroundRecreationAndBothLandscapeDirectionsResumeInference() {
        // Start from a known orientation even if an earlier test/device session left reverse landscape.
        compose.activityRule.scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
        compose.waitUntil(15_000) {
            compose.activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
        }
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
