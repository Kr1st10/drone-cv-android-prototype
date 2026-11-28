package ru.university.dronecv.diagnostics

import android.app.Application
import android.os.Looper
import android.os.SystemClock
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.IOException
import java.io.InterruptedIOException
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancel
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import ru.university.dronecv.camera.CaptureTimebase
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.camera.LiveBackend
import ru.university.dronecv.camera.LiveController
import ru.university.dronecv.camera.LiveInference
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox
import ru.university.dronecv.weact.SerialIo

@RunWith(AndroidJUnit4::class)
class DjiAttitudePanelInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val panelVisible = mutableStateOf(true)

    @Test fun readsOneAttitudeAndDisablesAnotherClickWhileBusy() {
        val usb = FakeWeAct(validReply)
        val canOpen = CompletableDeferred<Unit>()
        val opened = AtomicInteger()
        val model = show(usb) {
            opened.incrementAndGet()
            canOpen.await()
            usb
        }

        button().performClick()
        button().assertIsNotEnabled()
        turnButton().assertIsNotEnabled()
        compose.onNodeWithText("Читаем углы DJI…").assertIsDisplayed()
        compose.runOnIdle {
            model.readOnce()
            model.turnOnce()
        }
        canOpen.complete(Unit)

        val angles = String.format(Locale.getDefault(), "yaw %.1f° · pitch %.1f° · roll %.1f°", -179.7, -89.5, 12.3)
        expect(angles)
        assertEquals(1, opened.get())
        usb.assertExchange()
    }

    @Test fun turnsOnceAndShowsMeasuredYawAcrossWrap() {
        val usb = turnUsb(after = movedYawReply)
        val canOpen = CompletableDeferred<Unit>()
        val opened = AtomicInteger()
        val model = show(usb) {
            opened.incrementAndGet()
            canOpen.await()
            usb
        }

        turnButton().performClick()
        turnButton().assertIsNotEnabled()
        button().assertIsNotEnabled()
        compose.onNodeWithText("Выполняем один поворот DJI…").assertIsDisplayed()
        compose.runOnIdle {
            model.turnOnce()
            model.readOnce()
        }
        canOpen.complete(Unit)

        expectTurn("Принята", String.format(Locale.getDefault(), "%+.1f°", 2.7))
        expectTransmission("Подтверждена")
        assertEquals(1, opened.get())
        usb.assertWrites(request + yawCommand + afterRequest)
    }

    @Test fun closingPanelRejectsLateBaselineAndKeepsButtonsBusyThroughUsbClose() {
        val reply = HeldReply(request.last(), yawBeforeReply)
        val finishClose = CountDownLatch(1)
        val usb = FakeWeAct(heldReply = reply, finishClose = finishClose)
        val opened = AtomicInteger()
        show(usb) {
            if (opened.incrementAndGet() != 1) {
                assertEquals(1, usb.closed)
                throw WeActUsbException(WeActUsbIssue.ABSENT)
            }
            usb
        }

        turnButton().performClick()
        try {
            reply.awaitReading()
            closePanel()
            reply.release.countDown()
            assertTrue("USB cleanup did not start", usb.closing.await(5, TimeUnit.SECONDS))
            reopenPanel()
            turnButton().assertIsNotEnabled()
            button().assertIsNotEnabled()
            compose.onNodeWithText("Завершаем обмен с DJI…").assertIsDisplayed()
        } finally {
            reply.release.countDown()
            finishClose.countDown()
        }

        expectTurn("Не отправлена")
        expectTransmission("Не начата")
        compose.onNodeWithText("Попытка поворота отменена").assertIsDisplayed()
        assertEquals(0L, reply.returned.count)
        usb.assertExchange()
        assertEquals(1, opened.get())

        turnButton().performClick()
        expect("Адаптер WeAct не найден", firmware = false)
        assertEquals(2, opened.get())
    }

    @Test fun closingPanelRejectsPortReturnedAfterUsbPermission() {
        val usb = FakeWeAct()
        val permission = CompletableDeferred<Continuation<SerialIo>>()
        show(usb) { suspendCoroutine { permission.complete(it) } }
        turnButton().performClick()
        val grant = runBlocking { withTimeout(5_000) { permission.await() } }
        try {
            closePanel()
        } finally {
            grant.resume(usb)
        }
        reopenPanel()

        expectTurn("Не отправлена", firmware = false)
        expectTransmission("Не начата")
        compose.onNodeWithText("Попытка поворота отменена").assertIsDisplayed()
        assertEquals(emptyList<String>(), usb.writes)
        assertEquals(1, usb.closed)
    }

    @Test fun closingPanelAfterTransmissionKeepsUnconfirmedDjiStatus() {
        val reply = HeldReply(yawCommand.last())
        val usb = turnUsb(heldReply = reply)
        show(usb)
        turnButton().performClick()
        reply.awaitReading()
        closePanel()
        reopenPanel()

        expectTurn("Подтверждение не получено")
        expectTransmission("Подтверждена")
        compose.onNodeWithText("Попытка поворота отменена").assertIsDisplayed()
        usb.assertWrites(request + yawCommand)
    }

    @Test fun closingPanelAfterPositionAckKeepsAcceptanceAndNoMeasurement() {
        val reply = HeldReply(afterRequest.last())
        val usb = turnUsb(heldReply = reply)
        show(usb)
        turnButton().performClick()
        reply.awaitReading()
        closePanel()
        reopenPanel()

        expectTurn("Принята")
        expectTransmission("Подтверждена")
        compose.onNodeWithText("Попытка поворота отменена").assertIsDisplayed()
        usb.assertWrites(request + yawCommand + afterRequest)
    }

    @Test fun showsAcceptedCommandWithZeroMeasuredMovement() {
        val usb = turnUsb(after = unchangedYawReply)
        show(usb)
        turnButton().performClick()

        expectTurn("Принята", String.format(Locale.getDefault(), "%.1f°", 0.0))
        usb.assertWrites(request + yawCommand + afterRequest)
    }

    @Test fun stopsOnPositionTimeoutWithoutReadingAgainOrRepeatingTheCommand() {
        val usb = turnUsb(ack = null)
        show(usb)
        turnButton().performClick()

        expectTurn("Подтверждение не получено")
        compose.onNodeWithText("DJI не подтвердил команду за 2 с").assertIsDisplayed()
        usb.assertWrites(request + yawCommand)
        assertEquals(2_000_000_000L, usb.nowNs)
    }

    @Test fun baselineTimeoutStopsBeforeAnyPositionCommand() {
        val usb = FakeWeAct()
        show(usb)
        turnButton().performClick()

        expectTurn("Не отправлена")
        compose.onNodeWithText("Исходный угол: DJI не ответил").assertIsDisplayed()
        usb.assertExchange()
    }

    @Test fun postMovementReadTimeoutKeepsTheConfirmation() {
        val usb = turnUsb()
        show(usb)
        turnButton().performClick()

        expectTurn("Принята")
        compose.onNodeWithText("Угол после поворота: DJI не ответил").assertIsDisplayed()
        usb.assertWrites(request + yawCommand + afterRequest)
    }

    @Test fun originalWeActReturnsWithNewDeviceNameAndFreshSequence() {
        val original = turnUsb(detachOn = afterRequest[1])
        val reconnected = FakeWeAct(additionalReplies = mapOf(retryRequest.last() to unchangedYawReply + retryYawReply))
        val other = FakeWeAct()
        val originalDevice = FakeUsbDevice("001", "original", original)
        val otherDevice = FakeUsbDevice("002", "other", other)
        val returnedDevice = FakeUsbDevice("003", "original", reconnected)
        val attached = AtomicBoolean()
        val missing = CountDownLatch(1)
        val usb = WeActUsb {
            when {
                original.closed == 0 -> listOf(originalDevice, otherDevice)
                attached.get() -> listOf(otherDevice, returnedDevice)
                else -> listOf(otherDevice).also { missing.countDown() }
            }
        }
        showConnection(original, open = usb::open)
        turnButton().performClick()

        expectReconnect()
        assertTrue("WeAct absence was not observed", missing.await(5, TimeUnit.SECONDS))
        attached.set(true)

        expectTurn("Принята", String.format(Locale.getDefault(), "%+.1f°", 2.7))
        expectTransmission("Подтверждена")
        original.assertWrites(request + yawCommand + afterRequest.take(2))
        reconnected.assertWrites(retryRequest)
        otherDevice.assertUnused()
    }

    @Test fun fastReconnectWithoutSerialSendsOnlyOneMovementCommand() {
        val original = turnUsb(detachOn = afterRequest[1])
        val reconnected = FakeWeAct(additionalReplies = mapOf(retryRequest.last() to retryYawReply))
        val originalDevice = FakeUsbDevice("001", null, original)
        val returnedDevice = FakeUsbDevice("004", null, reconnected)
        val usb = WeActUsb {
            listOf(if (original.closed == 0) originalDevice else returnedDevice)
        }
        showConnection(original, open = usb::open)
        turnButton().performClick()

        expectTurn("Принята", String.format(Locale.getDefault(), "%+.1f°", 2.7))
        original.assertWrites(request + yawCommand + afterRequest.take(2))
        reconnected.assertWrites(retryRequest)
    }

    @Test fun waitsForOriginalWhileAnotherWeActStaysConnected() {
        val original = turnUsb(detachOn = afterRequest[1])
        val originalDevice = FakeUsbDevice("001", "original", original)
        val otherDevice = FakeUsbDevice("002", "other", FakeWeAct())
        val usb = WeActUsb {
            if (original.closed == 0) listOf(originalDevice, otherDevice) else listOf(otherDevice)
        }
        showConnection(original, reconnectTimeoutMs = 1_500, open = usb::open)
        turnButton().performClick()

        expectReconnect()
        expectTurn("Принята")
        compose.onNodeWithText("Истекло время ожидания исходного WeAct").assertIsDisplayed()
        original.assertWrites(request + yawCommand + afterRequest.take(2))
        otherDevice.assertUnused()
    }

    @Test fun indistinguishableAdaptersKeepAcceptanceWithoutMeasurement() {
        val original = turnUsb(detachOn = afterRequest[1])
        val originalDevice = FakeUsbDevice("001", null, original)
        val otherDevice = FakeUsbDevice("002", null, FakeWeAct())
        val usb = WeActUsb {
            if (original.closed == 0) listOf(originalDevice, otherDevice) else listOf(otherDevice)
        }
        showConnection(original, open = usb::open)
        turnButton().performClick()

        expectTurn("Принята")
        compose.onNodeWithText("Не удалось однозначно определить исходный WeAct").assertIsDisplayed()
        original.assertWrites(request + yawCommand + afterRequest.take(2))
        otherDevice.assertUnused()
    }

    @Test fun timeoutAfterReconnectKeepsTheConfirmationAndClosesBothPorts() {
        val original = turnUsb(detachOn = afterRequest[1])
        val reconnected = FakeWeAct()
        showReconnecting(original) { reconnected }
        turnButton().performClick()

        expectTurn("Принята")
        compose.onNodeWithText("Угол после поворота: DJI не ответил").assertIsDisplayed()
        original.assertWrites(request + yawCommand + afterRequest.take(2))
        reconnected.assertWrites(retryRequest)
        assertEquals(2_000_000_000L, reconnected.nowNs)
    }

    @Test fun permissionCanCompleteAfterReconnectDeadlineAndReadsOnlyOnce() {
        val original = turnUsb(detachOn = afterRequest[1])
        val returned = FakeWeAct(additionalReplies = mapOf(retryRequest.last() to retryYawReply))
        val grant = CompletableDeferred<Unit>()
        showReconnecting(original) {
            notifyUsbPermissionRequest(true)
            try { grant.await() } finally { notifyUsbPermissionRequest(false) }
            returned
        }
        turnButton().performClick()
        val prompt = "Подтвердите доступ к WeAct в Android"
        compose.waitUntil(5_000) { compose.onAllNodesWithText(prompt).fetchSemanticsNodes().isNotEmpty() }
        SystemClock.sleep(10_500)
        compose.onNodeWithText(prompt).assertIsDisplayed()
        grant.complete(Unit)
        expectTurn("Принята", String.format(Locale.getDefault(), "%+.1f°", 2.7))
        original.assertWrites(request + yawCommand + afterRequest.take(2))
        returned.assertWrites(retryRequest)
    }

    @Test fun deniedReconnectPermissionShowsDenial() = permissionFailure(WeActUsbIssue.ACCESS_DENIED,
        "Доступ к WeAct не предоставлен")

    @Test fun timedOutReconnectPermissionShowsPermissionTimeout() = permissionFailure(WeActUsbIssue.PERMISSION_TIMEOUT,
        "Истекло время ожидания USB-разрешения WeAct")

    private fun permissionFailure(issue: WeActUsbIssue, expected: String) {
        val original = turnUsb(detachOn = afterRequest[1])
        val response = CompletableDeferred<Unit>()
        showReconnecting(original) {
            notifyUsbPermissionRequest(true)
            try { response.await() } finally { notifyUsbPermissionRequest(false) }
            throw WeActUsbException(issue)
        }
        turnButton().performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Подтвердите доступ к WeAct в Android").fetchSemanticsNodes().isNotEmpty() }
        response.complete(Unit)
        expect(expected)
        original.assertWrites(request + yawCommand + afterRequest.take(2))
    }

    @Test fun cancellingDuringReconnectPermissionClosesOperation() {
        val original = turnUsb(detachOn = afterRequest[1])
        val released = CompletableDeferred<Unit>()
        showReconnecting(original) {
            notifyUsbPermissionRequest(true)
            try { CompletableDeferred<Unit>().await() } finally { released.complete(Unit) }
            error("cancelled")
        }
        turnButton().performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Подтвердите доступ к WeAct в Android").fetchSemanticsNodes().isNotEmpty() }
        closePanel()
        runBlocking { withTimeout(5_000) { released.await() } }
        reopenPanel()
        expect("Попытка поворота отменена")
        original.assertWrites(request + yawCommand + afterRequest.take(2))
    }

    @Test fun closingPanelWhileWaitingDiscardsLateReconnectedPort() {
        val original = turnUsb(detachOn = afterRequest[1])
        val reconnected = FakeWeAct()
        val permission = CompletableDeferred<Continuation<SerialIo>>()
        val openings = AtomicInteger()
        showReconnecting(original) {
            openings.incrementAndGet()
            suspendCoroutine { permission.complete(it) }
        }
        turnButton().performClick()
        val grant = runBlocking { withTimeout(5_000) { permission.await() } }
        try {
            expectReconnect()
            closePanel()
        } finally {
            grant.resume(reconnected)
        }
        reopenPanel()

        expectTurn("Принята")
        expectTransmission("Подтверждена")
        compose.onNodeWithText("Попытка поворота отменена").assertIsDisplayed()
        original.assertWrites(request + yawCommand + afterRequest.take(2))
        assertEquals(1, openings.get())
        assertEquals(emptyList<String>(), reconnected.writes)
        assertEquals(1, reconnected.closed)
    }

    @Test fun rejectedPositionCommandStopsBeforeMeasuringAgain() {
        val usb = turnUsb(ack = positionRejected)
        show(usb)
        turnButton().performClick()

        expectTurn("Отклонена (код 2)")
        usb.assertWrites(request + yawCommand)
    }

    @Test fun showsFirmwareWhenDjiTimesOut() {
        val usb = FakeWeAct()
        show(usb)
        button().performClick()
        expect("DJI не ответил")
        compose.onNodeWithText("WeAct не подтвердил передачу CAN").assertDoesNotExist()
        usb.assertExchange()
        assertEquals(2_000_000_000L, usb.nowNs)
    }

    @Test fun showsFirmwareWhenWeActRejectsUnacknowledgedCanTransmission() {
        assertUnconfirmedCanTransmission("\u0007")
    }

    @Test fun showsFirmwareWhenWeActDoesNotAcknowledgeCanTransmission() {
        assertUnconfirmedCanTransmission(null)
    }

    private fun assertUnconfirmedCanTransmission(canAck: String?) {
        val usb = FakeWeAct(firstCanAck = canAck)
        show(usb)
        button().performClick()
        expect(if (canAck == null) "Тайм-аут подтверждения передачи CAN от WeAct" else "WeAct отклонил передачу CAN")
        compose.onNodeWithText("DJI не ответил").assertDoesNotExist()
        assertEquals(setupCommands + request.first() + "C", usb.writes)
        assertEquals(1, usb.closed)
    }

    @Test fun cancelledReadClosesCanAndUsbWithoutResending() {
        assertCancelledReadClosesCanAndUsb(acknowledgeClose = true)
    }

    @Test fun cancelledReadClosesUsbWhenCanCloseTimesOut() {
        assertCancelledReadClosesCanAndUsb(acknowledgeClose = false)
    }

    private fun assertCancelledReadClosesCanAndUsb(acknowledgeClose: Boolean) {
        val reply = HeldReply(request.last())
        val usb = FakeWeAct(heldReply = reply, acknowledgeClose = acknowledgeClose)
        val scope = show(usb).viewModelScope
        button().performClick()
        try {
            reply.awaitReading()
        } finally {
            compose.runOnIdle { scope.cancel() }
        }
        runBlocking { withTimeout(5_000) { scope.coroutineContext.job.join() } }
        usb.assertExchange()
        assertEquals(if (acknowledgeClose) 0L else 2_000_000_000L, usb.nowNs)
    }

    @Test fun reportsBadCrcAndClosesUsb() {
        val usb = FakeWeAct(validReply.replace("t2222F589", "t2222F588"))
        show(usb)
        button().performClick()
        expect("Некорректный ответ DJI (FRAME_CRC)")
        usb.assertExchange()
    }

    @Test fun closesUsbEvenWhenCanOpenAndItsCleanupFail() {
        val usb = FakeWeAct(failOn = { command, writes -> command == "O" || (command == "C" && "O" in writes) })
        show(usb)
        button().performClick()
        expect("Ошибка обмена через WeAct")
        assertEquals(setupCommands + "C", usb.writes)
        assertEquals(1, usb.closed)
    }

    @Test fun reportsDetachDuringCanAndClosesUsb() {
        val usb = FakeWeAct(detachOn = request.first())
        show(usb)
        button().performClick()
        expect("Адаптер WeAct отключён")
        assertEquals(setupCommands + request.first() + "C", usb.writes)
        assertEquals(1, usb.closed)
    }

    @Test fun reportsMissingAdapter() {
        show { throw WeActUsbException(WeActUsbIssue.ABSENT) }
        button().performClick()
        expect("Адаптер WeAct не найден", firmware = false)
    }

    @Test fun reportsDeniedPermission() {
        show { throw WeActUsbException(WeActUsbIssue.ACCESS_DENIED) }
        button().performClick()
        expect("Доступ к WeAct не предоставлен", firmware = false)
    }

    @Test fun centeringWaitsForSettledYawThenUsesOnlyNewExposures() {
        val usb = centerUsb(moreReplies = secondStepReplies)
        val opened = AtomicInteger()
        centeringController().use { controller ->
            val model = showCentering(controller) {
                opened.incrementAndGet()
                WeActConnection(usb) { error("Unexpected reconnect") }
            }
            val earlyExposure = SystemClock.elapsedRealtimeNanos()
            publishCenteringFrame(controller, 0.78f, earlyExposure)
            button().assertIsNotEnabled()
            turnButton().assertIsNotEnabled()
            compose.runOnIdle { model.readOnce(); model.turnOnce() }
            compose.waitUntil(8_000) { model.centering.value.completedSteps == 1 }
            assertEquals("Принята", model.centering.value.steps.single().command.confirmation)
            assertEquals(-177.5, checkNotNull(model.centering.value.steps.single().settled), 0.0)

            publishCenteringFrame(controller, 0.22f, earlyExposure + 1)
            publishCenteringFrame(controller, 0.70f, SystemClock.elapsedRealtimeNanos())
            compose.waitUntil(8_000) { model.centering.value.completedSteps == 2 }
            assertEquals(-174.7, checkNotNull(model.centering.value.steps.last().settled), 0.0)

            publishCenteringFrame(controller, 0.5f, SystemClock.elapsedRealtimeNanos())
            expectCenteringStop(model, CenteringStop.CENTERED)
            usb.assertWrites(request + centerCommand + afterRequest + settledRequest + secondStepRequests)
            assertEquals(1, opened.get())
            button().assertIsEnabled()
        }
    }

    @Test fun centeringStopsWithoutMovementWhenTheLatestFrameIsCenteredDuringYawRead() {
        withFrameDuringYawRead(latestX = 0.5f) { model, usb, _ ->
            expectCenteringStop(model, CenteringStop.CENTERED)
            assertEquals(0, model.centering.value.completedSteps)
            assertTrue(model.centering.value.steps.isEmpty())
            assertEquals(0.0, checkNotNull(model.centering.value.offsetPercent), 0.01)
            usb.assertWrites(request)
        }
    }

    @Test fun centeringReplansWhenTheLatestFrameCrossesDuringYawRead() {
        withFrameDuringYawRead(latestX = 0.22f, moreReplies = leftStepReplies) { model, usb, publish ->
            compose.waitUntil(8_000) { model.centering.value.completedSteps == 1 }
            val step = model.centering.value.steps.single()
            assertEquals(1, step.number)
            assertEquals(CenteringDirection.LEFT, step.direction)
            assertEquals(-2.8, checkNotNull(step.command.yawDelta), 0.0)
            publish(0.5f)
            expectCenteringStop(model, CenteringStop.CENTERED)
            usb.assertWrites(request + secondStepRequests.take(3) + leftCommand + secondStepRequests.takeLast(6))
        }
    }

    @Test fun centeringSendsOneCommandWhenTheLatestFrameStaysOnTheSameSideDuringYawRead() {
        withFrameDuringYawRead(latestX = 0.72f) { model, usb, publish ->
            compose.waitUntil(8_000) { model.centering.value.completedSteps == 1 }
            assertEquals(CenteringDirection.RIGHT, model.centering.value.steps.single().direction)
            publish(0.5f)
            expectCenteringStop(model, CenteringStop.CENTERED)
            usb.assertWrites(request + centerCommand + afterRequest + settledRequest)
        }
    }

    private fun withFrameDuringYawRead(
        latestX: Float,
        moreReplies: Map<String, String> = emptyMap(),
        verify: (DjiAttitudeViewModel, FakeWeAct, (Float) -> Unit) -> Unit,
    ) {
        val baseline = HeldReply(request.last(), yawBeforeReply)
        val usb = centerUsb(heldReply = baseline, moreReplies = moreReplies)
        val clock = AtomicLong(1_000_000_000L)
        centeringController(clock::get).use { controller ->
            val model = showCentering(controller, clock::get) { WeActConnection(usb) { error("Unexpected reconnect") } }
            val publish: (Float) -> Unit = { x ->
                publishCenteringFrame(controller, x, clock.addAndGet(100_000_000L))
            }
            try {
                publish(0.78f)
                baseline.awaitReading()
                publish(0.70f)
                publish(latestX)
            } finally {
                baseline.release.countDown()
            }
            verify(model, usb, publish)
        }
    }

    @Test fun centeringStopsAfterDjiAckTimeoutAndKeepsKnownTransmission() {
        val usb = centerUsb(ack = null)
        centeringController().use { controller ->
            val model = showCentering(controller) { WeActConnection(usb) { error("Unexpected reconnect") } }
            publishCenteringFrame(controller, 0.78f, SystemClock.elapsedRealtimeNanos())
            expectCenteringStop(model, CenteringStop.STEP_TIMEOUT)
            val result = model.centering.value.steps.single()
            assertEquals("Подтверждена", result.command.transmission)
            assertEquals("Подтверждение не получено", result.command.confirmation)
            assertEquals(null, result.command.yawDelta)
            usb.assertWrites(request + centerCommand)
        }
    }

    @Test fun centeringReopensForReadOnlyAndDoesNotContinueAfterDetach() {
        val usb = centerUsb(detachOn = settledRequest.last())
        val reconnected = FakeWeAct(additionalReplies = mapOf(centerRecoveryRequest.last() to centerRecoveryReply))
        centeringController().use { controller ->
            val model = showCentering(controller) {
                WeActConnection(usb) {
                    assertEquals(1, usb.closed)
                    reconnected
                }
            }
            publishCenteringFrame(controller, 0.78f, SystemClock.elapsedRealtimeNanos())
            expectCenteringStop(model, CenteringStop.ERROR)
            val state = model.centering.value
            assertEquals(0, state.completedSteps)
            val result = state.steps.single()
            assertEquals("Принята", result.command.confirmation)
            assertEquals(-177.4, checkNotNull(result.recovered), 0.0)
            usb.assertWrites(request + centerCommand + afterRequest + settledRequest)
            reconnected.assertWrites(centerRecoveryRequest)
        }
    }

    @Test fun centeringStopKeepsAcknowledgementAndReleasesThePort() {
        val held = HeldReply(afterRequest.last())
        val usb = centerUsb(heldReply = held)
        centeringController().use { controller ->
            val model = showCentering(controller) { WeActConnection(usb) { error("Unexpected reconnect") } }
            publishCenteringFrame(controller, 0.78f, SystemClock.elapsedRealtimeNanos())
            held.awaitReading()
            compose.onNodeWithTag("physical-centering-toggle").performClick()
            expectCenteringStop(model, CenteringStop.STOPPED)
            assertEquals(0, model.centering.value.completedSteps)
            assertEquals("Принята", model.centering.value.steps.single().command.confirmation)
            usb.assertWrites(request + centerCommand + afterRequest)
            button().assertIsEnabled()
        }
    }

    private class CenteringFrame(val x: Float) : AutoCloseable {
        override fun close() = Unit
    }

    private fun centeringController(nowNs: () -> Long = SystemClock::elapsedRealtimeNanos) = LiveController(object : LiveBackend<CenteringFrame> {
        override fun infer(frame: CenteringFrame, confidence: Float) = LiveInference(
            listOf(Detection("drone", 0.95f, NormalizedBox(frame.x - 0.05f, 0.4f, frame.x + 0.05f, 0.6f))),
            width = 100, height = 100, inferenceMs = 1.0,
        )
        override fun close() = Unit
    }, worker = { it.run() }, eventTime = nowNs).apply {
        check(setTrackingEnabled(false))
        configure(true, 0.5f)
        publishCenteringFrame(this, 0.5f, nowNs())
    }

    private fun publishCenteringFrame(controller: LiveController<CenteringFrame>, x: Float, captureNs: Long) =
        controller.analyze(CenteringFrame(x), stamp = FrameStamp(captureNs, CaptureTimebase.ELAPSED_REALTIME, captureNs))

    private fun showCentering(
        controller: LiveController<*>,
        nowNs: () -> Long = SystemClock::elapsedRealtimeNanos,
        open: suspend () -> WeActConnection,
    ): DjiAttitudeViewModel {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val model = DjiAttitudeViewModel(app, open, nowNs = nowNs, initialSequence = 0x1234)
        compose.setContent {
            MaterialTheme {
                Column {
                    PhysicalCenteringControls(controller, yoloReady = true, model = model)
                    PhysicalCenteringReadings(model)
                    DjiAttitudePanel(model)
                }
            }
        }
        compose.onNodeWithTag("physical-centering-toggle").performClick()
        return model
    }

    private fun expectCenteringStop(model: DjiAttitudeViewModel, reason: CenteringStop) {
        compose.waitUntil(15_000) { model.centering.value.reason != null }
        assertEquals(reason, model.centering.value.reason)
    }

    private fun show(
        usb: FakeWeAct? = null,
        open: suspend () -> SerialIo = { checkNotNull(usb) },
    ) = showConnection(usb) { WeActConnection(open()) { error("Unexpected WeAct reconnect") } }

    private fun showConnection(
        usb: FakeWeAct?,
        reconnectTimeoutMs: Long = 10_000,
        open: suspend () -> WeActConnection,
    ): DjiAttitudeViewModel {
        val application = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val model = DjiAttitudeViewModel(
            application,
            openWeAct = {
                assertNotEquals(Looper.getMainLooper(), Looper.myLooper())
                open()
            },
            nowNs = { usb?.nowNs ?: 0L },
            initialSequence = 0x1234,
            reconnectTimeoutMs = reconnectTimeoutMs,
        )
        compose.setContent {
            MaterialTheme { Column { if (panelVisible.value) DjiAttitudePanel(model) } }
        }
        return model
    }

    private fun showReconnecting(
        original: FakeWeAct,
        reopen: suspend () -> SerialIo,
    ) {
        showConnection(original) {
            WeActConnection(original) {
                assertEquals(1, original.closed)
                reopen()
            }
        }
    }

    private fun closePanel() {
        compose.runOnIdle { panelVisible.value = false }
        turnButton().assertDoesNotExist()
    }

    private fun reopenPanel() = compose.runOnIdle { panelVisible.value = true }

    private fun button() = compose.onNodeWithText("Прочитать углы DJI")

    private fun turnButton() = compose.onNodeWithText("Один поворот DJI")

    private fun expectTurn(confirmation: String, delta: String = "Не измерен", firmware: Boolean = true) {
        expect("Команда DJI: $confirmation", firmware)
        compose.onNodeWithText("Фактический поворот (yaw): $delta").assertIsDisplayed()
        turnButton().assertIsEnabled()
    }

    private fun expectTransmission(value: String) =
        compose.onNodeWithText("Передача WeAct: $value").assertIsDisplayed()

    private fun expect(value: String, firmware: Boolean = true) {
        compose.waitUntil(5_000) {
            compose.onAllNodes(hasText("Прочитать углы DJI") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText(value).assertIsDisplayed()
        if (firmware) compose.onNodeWithText(version).assertIsDisplayed()
        else compose.onNodeWithText(version).assertDoesNotExist()
        button().assertIsEnabled()
    }

    private fun expectReconnect() {
        val waiting = "Ожидаем подключения WeAct…"
        compose.waitUntil(5_000) { compose.onAllNodesWithText(waiting).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(waiting).assertIsDisplayed()
        compose.onNodeWithText("Команда DJI: Принята").assertIsDisplayed()
        compose.onNodeWithText("Фактический поворот (yaw): Не измерен").assertIsDisplayed()
        button().assertIsNotEnabled()
        turnButton().assertIsNotEnabled()
    }

    private fun turnUsb(
        ack: String? = positionAck,
        after: String? = null,
        detachOn: String? = null,
        heldReply: HeldReply? = null,
    ) =
        FakeWeAct(
            yawBeforeReply,
            detachOn = detachOn,
            heldReply = heldReply,
            additionalReplies = mapOf(yawCommand.last() to ack, afterRequest.last() to after),
        )

    private fun centerUsb(
        ack: String? = centerAck,
        detachOn: String? = null,
        heldReply: HeldReply? = null,
        moreReplies: Map<String, String> = emptyMap(),
    ) = FakeWeAct(
        yawBeforeReply,
        detachOn = detachOn,
        heldReply = heldReply,
        additionalReplies = mapOf(centerCommand.last() to ack, afterRequest.last() to movedYawReply,
            settledRequest.last() to settledYawReply) + moreReplies,
    )

    private class FakeUsbDevice(
        override val name: String,
        private val serialNumber: String?,
        private val port: FakeWeAct,
    ) : WeActUsbDevice {
        private var permission = false
        private var openings = 0

        override fun permittedSerial(): String? = serialNumber.takeIf { permission }

        override suspend fun ensurePermission() {
            permission = true
        }

        override fun open(observeAttachedCount: ((Int) -> Unit)?): SerialIo {
            check(permission)
            openings++
            return port
        }

        fun assertUnused() {
            assertEquals("Unexpected permission request for $name", false, permission)
            assertEquals(0, openings)
            assertEquals(emptyList<String>(), port.writes)
        }
    }

    private class HeldReply(val afterWrite: String, private val lateReply: String? = null) {
        private val reading = CountDownLatch(1)
        val release = CountDownLatch(1)
        val returned = CountDownLatch(1)

        fun awaitReading() {
            assertTrue("DJI reply read did not start", reading.await(5, TimeUnit.SECONDS))
        }

        fun read(): ByteArray {
            reading.countDown()
            while (true) {
                try {
                    check(release.await(10, TimeUnit.SECONDS) && lateReply != null) { "DJI reply was never released" }
                    returned.countDown()
                    return lateReply.toByteArray(Charsets.US_ASCII)
                } catch (error: InterruptedException) {
                    if (lateReply == null) {
                        Thread.currentThread().interrupt()
                        throw InterruptedIOException("DJI reply read interrupted").also { it.initCause(error) }
                    }
                    // Simulate a native read that still delivers data after cancellation.
                }
            }
        }
    }

    private class FakeWeAct(
        private val reply: String? = null,
        private val failOn: (String, List<String>) -> Boolean = { _, _ -> false },
        private val detachOn: String? = null,
        private val firstCanAck: String? = "\r",
        private val heldReply: HeldReply? = null,
        private val acknowledgeClose: Boolean = true,
        private val additionalReplies: Map<String, String?> = emptyMap(),
        private val finishClose: CountDownLatch? = null,
    ) : SerialIo {
        private val pending = ArrayDeque<String>()
        val writes = mutableListOf<String>()
        val closing = CountDownLatch(1)
        var nowNs = 0L
            private set
        var closed = 0
            private set

        override fun read(timeoutNs: Long): ByteArray? {
            assertNotEquals(Looper.getMainLooper(), Looper.myLooper())
            val chunk = pending.removeFirstOrNull()
            if (chunk == null) {
                if (heldReply != null && writes.last() == heldReply.afterWrite) return heldReply.read()
                nowNs += timeoutNs
            }
            return chunk?.toByteArray(Charsets.US_ASCII)
        }

        override fun write(bytes: ByteArray, timeoutNs: Long) {
            assertNotEquals(Looper.getMainLooper(), Looper.myLooper())
            if (Thread.currentThread().isInterrupted) throw InterruptedIOException("USB write interrupted")
            val command = bytes.toString(Charsets.US_ASCII).removeSuffix("\r")
            writes += command
            if (command == detachOn) throw WeActUsbException(WeActUsbIssue.DETACHED)
            if (failOn(command, writes)) throw IOException("USB write failed")
            when (command) {
                "V" -> {
                    pending.addLast(version.take(12))
                    pending.addLast(version.drop(12) + "\r")
                }
                "H0" -> pending.addLast("\u0007")
                "C" -> if (acknowledgeClose || "O" !in writes) pending.addLast("\r")
                heldReply?.afterWrite -> pending.addLast("\r")
                request.first() -> firstCanAck?.let(pending::addLast)
                request.last() -> pending.addLast((reply ?: "") + "\r")
                else -> pending.addLast(additionalReplies[command].orEmpty() + "\r")
            }
        }

        override fun close() {
            assertNotEquals(Looper.getMainLooper(), Looper.myLooper())
            closing.countDown()
            check(finishClose?.await(10, TimeUnit.SECONDS) != false) { "USB close was never released" }
            closed++
        }

        fun assertExchange() = assertWrites(request)

        fun assertWrites(exchange: List<String>) {
            assertEquals(setupCommands + exchange + "C", writes)
            assertEquals(1, closed)
        }
    }

    private companion object {
        const val version = "WeAct Studio V1.0.0.3_bb264e71"
        val setupCommands = listOf("V", "C", "H0", "M0", "S8", "O")
        val request = listOf("t2238AA13000300000000", "t2238341286730E020188", "t2233556F78")
        val validReply = "t2228AA1A002000000000\rt22283412FEE10E020001\rt2228FBF87B0081FC3859\rt2222F589\r"
        val yawBeforeReply = "t2228AA1A002000000000\rt22283412FEE10E020001\rt222805070A00F8FF21B2\rt22227ED8\r"
        val yawCommand = listOf("t2238AA1A000300000000", "t22383612ED430E001E00", "t2238000000000C0A7235", "t2232B2BF")
        val positionAck = "t2228AA13002000000000\rt2228361295D10E000061\rt2223234C05\r"
        val positionRejected = "t2228AA13002000000000\rt2228361295D10E00024D\rt22234242EB\r"
        val afterRequest = listOf("t2238AA13000300000000", "t2238351287E30E020128", "t223396385E")
        val retryRequest = listOf("t2238AA13000300000000", "t2238371286830E0201B2", "t223359E1CF")
        val movedYawReply = "t2228AA1A002000000000\rt22283512FF710E020001\rt222810F90A00F8FF7893\rt2222DCA3\r"
        val unchangedYawReply = "t2228AA1A002000000000\rt22283512FF710E020001\rt222805070A00F8FF6CEE\rt2222C307\r"
        val retryYawReply = "t2228AA1A002000000000\rt22283712FE110E020001\rt222810F90A00F8FF828D\rt2222C389\r"
        val centerCommand = listOf("t2238AA1A000300000000", "t22383712ECD30E001E00", "t2238000000000C0A3F69", "t22320F60")
        val centerAck = "t2228AA13002000000000\rt2228371294410E0000C1\rt2223E01B23\r"
        val settledRequest = listOf("t2238AA13000300000000", "t2238361287130E020112", "t22339AB6E9")
        val settledYawReply = "t2228AA1A002000000000\rt22283612FF810E020001\rt222811F90A00F8FF6A02\rt2222229D\r"
        val centerRecoveryRequest = listOf("t2238AA13000300000000", "t2238381283730E02018C", "t2233B02F77")
        val centerRecoveryReply = "t2228AA1A002000000000\rt22283812FBE10E020001\rt222812F90A00F8FF0388\rt2222FF83\r"
        val secondStepRequests = listOf(
            "t2238AA13000300000000", "t2238391282E30E02012C", "t2233737851",
            "t2238AA1A000300000000", "t22383C12EBE30E001E00", "t2238000000000C0A41F0", "t2232C573",
            "t2238AA13000300000000", "t22383A1282130E020116", "t22337FF6E6",
            "t2238AA13000300000000", "t22383B1283830E0201B6", "t2233BCA1C0",
        )
        val secondStepReplies = mapOf(
            "t2233737851" to "t2228AA1A002000000000\rt22283912FA710E020001\rt222811F90A00F8FFE0A6\rt2222D6DA\r",
            "t2232C573" to "t2228AA13002000000000\rt22283C1293710E00008A\rt2223901763\r",
            "t22337FF6E6" to "t2228AA1A002000000000\rt22283A12FA810E020001\rt22282CF90A00F8FF24F0\rt22229097\r",
            "t2233BCA1C0" to "t2228AA1A002000000000\rt22283B12FB110E020001\rt22282DF90A00F8FFCC7F\rt22227183\r",
        )
        val leftCommand = listOf("t2238AA1A000300000000", "t22383C12EBE30E00E2FF", "t2238000000000C0A74BB", "t22323749")
        val leftStepReplies = mapOf(
            "t2233737851" to secondStepReplies.getValue("t2233737851"),
            leftCommand.last() to secondStepReplies.getValue("t2232C573"),
            "t22337FF6E6" to "t2228AA1A002000000000\rt22283A12FA810E020001\rt222806070A00F8FF4838\rt2222A3C6\r",
            "t2233BCA1C0" to "t2228AA1A002000000000\rt22283B12FB110E020001\rt222805070A00F8FFAB16\rt22228A9F\r",
        )
    }
}
