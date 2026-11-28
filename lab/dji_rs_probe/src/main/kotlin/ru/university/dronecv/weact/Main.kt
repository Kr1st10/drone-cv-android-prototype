package ru.university.dronecv.weact

import ru.university.dronecv.gimbal.DjiRsAttitudeExchange
import ru.university.dronecv.gimbal.DjiRsAttitudeReader
import ru.university.dronecv.gimbal.DjiRsAttitudeReply
import java.io.IOException
import kotlin.system.exitProcess

private const val USAGE = """Usage:
  dji-rs-probe adapter-info --port /dev/cu.usbmodem… [--timeout-ms N]
  dji-rs-probe read-attitude --port /dev/cu.usbmodem… --profile sdk-classic-stream
      --can-bitrate BITS_PER_SECOND --tx-id ID --rx-id ID [--timeout-ms N]
  dji-rs-probe nudge --port /dev/cu.usbmodem… --profile sdk-classic-stream
      --can-bitrate BITS_PER_SECOND --tx-id ID --rx-id ID
      --axis yaw|pitch --direction positive|negative [--timeout-ms N]
      Sends one relative 3-degree move over 1 second after a successful attitude read."""

private data class ProbeOptions(
    val port: String,
    val timeoutNs: Long,
    val profile: ClassicStreamProfile?,
    val nudge: GimbalNudge?,
)

fun main(args: Array<String>) {
    exitProcess(runProbe(args))
}

internal fun runProbe(
    args: Array<String>,
    openPort: (String) -> SerialIo = MacSerialIo::open,
    nowNs: () -> Long = System::nanoTime,
    output: (String) -> Unit = ::println,
    error: (String) -> Unit = System.err::println,
    pauseMs: (Long) -> Unit = Thread::sleep,
): Int {
    if (args.isEmpty() || args.contentEquals(arrayOf("--help"))) {
        output(USAGE)
        return 0
    }
    val options = try {
        parseOptions(args)
    } catch (e: IllegalArgumentException) {
        error(e.message.orEmpty())
        error(USAGE)
        return 2
    }
    return try {
        openPort(options.port).use { serial ->
            if (options.profile == null) {
                output(SlcanWire(serial, nowNs).version(options.timeoutNs))
                0
            } else {
                SlcanDjiRsTransport(serial, options.profile, options.timeoutNs, nowNs).use { transport ->
                    transport.open()
                    if (options.nudge != null) {
                        options.nudge.run(transport, options.timeoutNs, nowNs, pauseMs, output)
                        0
                    } else {
                        val exchange = DjiRsAttitudeReader(transport, nanoTime = nowNs).readOnce(options.timeoutNs)
                        output("seq=${exchange.sequence} events=${exchange.events} result=${exchange.outcome}")
                        if ((exchange.outcome as? DjiRsAttitudeExchange.Outcome.Reply)?.value is DjiRsAttitudeReply.Angles) 0 else 1
                    }
                }
            }
        }
    } catch (e: IOException) {
        error(e.message.orEmpty())
        1
    } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        error("Interrupted during the gimbal measurement")
        1
    } catch (e: IllegalArgumentException) {
        error(e.message.orEmpty())
        2
    }
}

private fun parseOptions(args: Array<String>): ProbeOptions {
    val operation = args.first()
    val usbOptions = setOf("--port", "--timeout-ms")
    val canOptions = usbOptions + setOf("--profile", "--can-bitrate", "--tx-id", "--rx-id")
    val allowed = when (operation) {
        "adapter-info" -> usbOptions
        "read-attitude" -> canOptions
        "nudge" -> canOptions + setOf("--axis", "--direction")
        else -> throw IllegalArgumentException("Unknown operation: $operation")
    }
    require(args.size % 2 == 1) { "Each option needs a value" }
    val values = mutableMapOf<String, String>()
    for (i in 1 until args.size step 2) {
        val key = args[i]
        require(key in allowed && key !in values) { "Unknown or repeated option: $key" }
        values[key] = args[i + 1]
    }

    fun required(key: String): String =
        requireNotNull(values[key]?.takeIf { it.isNotBlank() }) { "Specify $key" }

    fun id(key: String): Int {
        val text = required(key)
        val id = if (text.startsWith("0x", ignoreCase = true)) text.drop(2).toIntOrNull(16) else text.toIntOrNull()
        return requireNotNull(id) { "$key must be an integer (decimal or 0x-prefixed hex)" }
    }

    val port = required("--port")
    val timeoutMs = (values["--timeout-ms"] ?: "2000").toLongOrNull()
    require(timeoutMs != null && timeoutMs in 1..10_000) { "--timeout-ms must be between 1 and 10000" }
    val profile = if (operation != "adapter-info") {
        require(required("--profile") == "sdk-classic-stream") { "Supported profile: sdk-classic-stream" }
        val bitrate = requireNotNull(required("--can-bitrate").toIntOrNull()) { "--can-bitrate must be an integer" }
        ClassicStreamProfile(bitrate, id("--tx-id"), id("--rx-id"))
    } else null

    val nudge = if (operation == "nudge") {
        val axis = when (required("--axis")) {
            "yaw" -> NudgeAxis.YAW
            "pitch" -> NudgeAxis.PITCH
            else -> throw IllegalArgumentException("--axis must be yaw or pitch")
        }
        val positive = when (required("--direction")) {
            "positive" -> true
            "negative" -> false
            else -> throw IllegalArgumentException("--direction must be positive or negative")
        }
        GimbalNudge(axis, positive)
    } else null

    return ProbeOptions(port, timeoutMs * 1_000_000L, profile, nudge)
}
