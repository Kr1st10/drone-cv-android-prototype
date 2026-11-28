package ru.university.dronecv.diagnostics

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull
import ru.university.dronecv.weact.SerialIo

internal class AndroidWeActUsb(private val context: Context) {
    suspend fun open(): WeActConnection {
        val usb = context.getSystemService(UsbManager::class.java)
            ?: throw WeActUsbException(WeActUsbIssue.ABSENT)
        return WeActUsb {
            usb.deviceList.values.filter(::isWeAct).map { Device(usb, it) }
        }.open()
    }

    private inner class Device(private val usb: UsbManager, private val device: UsbDevice) : WeActUsbDevice {
        override val name get() = device.deviceName

        override fun permittedSerial(): String? = try {
            if (usb.hasPermission(device)) device.serialNumber?.takeIf { it.isNotBlank() } else null
        } catch (_: SecurityException) {
            null
        }

        override suspend fun ensurePermission() {
            currentCoroutineContext().ensureActive()
            usb.checkAttached(device)
            if (!usb.hasPermission(device)) requestPermission(usb, device)
        }

        override fun open(observeAttachedCount: ((Int) -> Unit)?): SerialIo =
            openPort(usb, device, observeAttachedCount)
    }

    private fun openPort(usb: UsbManager, device: UsbDevice, observeAttachedCount: ((Int) -> Unit)?): SerialIo {
        usb.checkAttached(device, observeAttachedCount)
        val port = CdcPort.find(device)
        val connection = try {
            usb.openDevice(device)
        } catch (error: SecurityException) {
            usb.checkAttached(device)
            throw WeActUsbException(WeActUsbIssue.ACCESS_DENIED).also { it.initCause(error) }
        } ?: run {
            usb.checkAttached(device)
            if (!usb.hasPermission(device)) throw WeActUsbException(WeActUsbIssue.ACCESS_DENIED)
            throw IOException("WeAct USB open failed")
        }
        val serial = AndroidUsbSerialIo(usb, device, connection, port, observeAttachedCount)
        try {
            serial.configure()
            return serial
        } catch (error: IOException) {
            serial.close()
            usb.checkAttached(device)
            throw error
        } catch (error: RuntimeException) {
            serial.close()
            throw error
        }
    }

    private suspend fun requestPermission(usb: UsbManager, device: UsbDevice) {
        val action = "${context.packageName}.USB_PERMISSION.${UUID.randomUUID()}"
        val response = CompletableDeferred<Unit>()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == action) {
                    response.complete(Unit)
                } else if (intent.action == UsbManager.ACTION_USB_DEVICE_DETACHED &&
                    IntentCompat.getParcelableExtra(intent, UsbManager.EXTRA_DEVICE, UsbDevice::class.java) == device
                ) {
                    response.completeExceptionally(WeActUsbException(WeActUsbIssue.DETACHED))
                }
            }
        }
        val callback = PendingIntent.getBroadcast(
            context, 0, Intent(action).setPackage(context.packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_ONE_SHOT,
        )
        try {
            ContextCompat.registerReceiver(context, receiver, IntentFilter(action).apply {
                addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            }, ContextCompat.RECEIVER_NOT_EXPORTED)
            try {
                usb.checkAttached(device)
                notifyUsbPermissionRequest(true)
                val received = try {
                    usb.requestPermission(device, callback)
                    withTimeoutOrNull(60_000) { response.await(); true } ?: false
                } finally {
                    notifyUsbPermissionRequest(false)
                }
                if (!received) throw WeActUsbException(WeActUsbIssue.PERMISSION_TIMEOUT)
                usb.checkAttached(device)
                if (!usb.hasPermission(device)) throw WeActUsbException(WeActUsbIssue.ACCESS_DENIED)
            } finally {
                context.unregisterReceiver(receiver)
            }
        } finally {
            callback.cancel()
        }
    }
}

private fun isWeAct(device: UsbDevice): Boolean =
    device.vendorId == 0x0483 && device.productId == 0x5740 &&
        device.manufacturerName == "WeAct Studio" && device.productName == "USB2CANV1 ComPort"

private fun UsbManager.checkAttached(device: UsbDevice, observeAttachedCount: ((Int) -> Unit)? = null) {
    val devices = deviceList
    observeAttachedCount?.invoke(devices.values.count(::isWeAct))
    if (device.deviceName !in devices) throw WeActUsbException(WeActUsbIssue.DETACHED)
}

private data class CdcPort(
    val control: UsbInterface,
    val data: UsbInterface,
    val input: UsbEndpoint,
    val output: UsbEndpoint,
) {
    companion object {
        fun find(device: UsbDevice): CdcPort {
            val interfaces = (0 until device.interfaceCount).map(device::getInterface)
            val control = interfaces.singleOrNull {
                it.interfaceClass == UsbConstants.USB_CLASS_COMM && it.interfaceSubclass == 2
            }
            val data = interfaces.singleOrNull { it.interfaceClass == UsbConstants.USB_CLASS_CDC_DATA }
            if (control != null && data != null) {
                val endpoints = (0 until data.endpointCount).map(data::getEndpoint)
                    .filter { it.type == UsbConstants.USB_ENDPOINT_XFER_BULK }
                val input = endpoints.singleOrNull { it.direction == UsbConstants.USB_DIR_IN }
                val output = endpoints.singleOrNull { it.direction == UsbConstants.USB_DIR_OUT }
                if (input != null && output != null) return CdcPort(control, data, input, output)
            }
            throw IOException("WeAct CDC ACM interfaces unavailable")
        }
    }
}

private class AndroidUsbSerialIo(
    private val usb: UsbManager,
    private val device: UsbDevice,
    private val connection: UsbDeviceConnection,
    private val port: CdcPort,
    private val observeAttachedCount: ((Int) -> Unit)?,
) : SerialIo {
    private val readBuffer = ByteArray(port.input.maxPacketSize)
    private var controlClaimed = false
    private var dataClaimed = false

    fun configure() {
        controlClaimed = connection.claimInterface(port.control, true)
        if (!controlClaimed) throw IOException("WeAct USB control interface claim failed")
        dataClaimed = connection.claimInterface(port.data, true)
        if (!dataClaimed) throw IOException("WeAct USB data interface claim failed")

        // CDC line coding is little-endian: 115200 baud, one stop bit, no parity, 8 data bits.
        val lineCoding = byteArrayOf(0x00, 0xC2.toByte(), 0x01, 0x00, 0x00, 0x00, 0x08)
        if (connection.controlTransfer(0x21, 0x20, 0, port.control.id, lineCoding, lineCoding.size, 500)
            != lineCoding.size
        ) {
            throw IOException("WeAct USB line coding failed")
        }
        if (connection.controlTransfer(0x21, 0x22, 0x03, port.control.id, null, 0, 500) != 0) {
            throw IOException("WeAct USB DTR/RTS setup failed")
        }
    }

    override fun read(timeoutNs: Long): ByteArray? {
        val deadline = System.nanoTime() + timeoutNs
        while (true) {
            checkInterrupted()
            val remaining = deadline - System.nanoTime()
            if (remaining <= 0) return null
            val count = connection.bulkTransfer(port.input, readBuffer, readBuffer.size,
                remaining.toUsbMillis().coerceAtMost(100))
            if (count > 0) return readBuffer.copyOf(count)
            usb.checkAttached(device, observeAttachedCount)
        }
    }

    override fun write(bytes: ByteArray, timeoutNs: Long) {
        if (observeAttachedCount != null) {
            checkInterrupted()
            usb.checkAttached(device, observeAttachedCount)
        }
        val deadline = System.nanoTime() + timeoutNs
        var sent = 0
        while (sent < bytes.size) {
            checkInterrupted()
            val remaining = deadline - System.nanoTime()
            if (remaining <= 0) throw SocketTimeoutException("WeAct USB write timed out")
            val count = connection.bulkTransfer(port.output, bytes, sent, bytes.size - sent, remaining.toUsbMillis())
            if (count <= 0) {
                usb.checkAttached(device, observeAttachedCount)
                throw IOException("WeAct USB write failed")
            }
            sent += count
        }
    }

    override fun close() {
        try {
            if (dataClaimed) connection.releaseInterface(port.data)
            if (controlClaimed) connection.releaseInterface(port.control)
        } finally {
            connection.close()
        }
    }

    private fun checkInterrupted() {
        if (Thread.currentThread().isInterrupted) throw InterruptedIOException("WeAct USB I/O interrupted")
    }

    private fun Long.toUsbMillis(): Int =
        (1 + (this - 1) / 1_000_000).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
}
