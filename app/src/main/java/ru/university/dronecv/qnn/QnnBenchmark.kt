package ru.university.dronecv.qnn

import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtEpDevice
import ai.onnxruntime.OrtHardwareDevice.OrtHardwareDeviceType
import ai.onnxruntime.OrtLoggingLevel
import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.system.Os
import android.util.Log
import java.io.File
import java.io.FileNotFoundException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import java.util.UUID
import kotlin.math.abs
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import ru.university.dronecv.BuildConfig
import ru.university.dronecv.camera.CameraFrameSnapshot
import ru.university.dronecv.detection.onnx.ModelFiles
import ru.university.dronecv.detection.onnx.YoloEngineOptions
import ru.university.dronecv.detection.onnx.YoloOnnxEngine
import ru.university.dronecv.detection.onnx.YoloResult
import ru.university.dronecv.detection.onnx.toArgbImage
import ru.university.dronecv.detection.yolo.Letterbox
import ru.university.dronecv.detection.yolo.PostprocessConfig
import ru.university.dronecv.detection.yolo.YoloDetection
import ru.university.dronecv.detection.yolo.YoloPostprocessor
import ru.university.dronecv.diagnostics.durationSummary
import ru.university.dronecv.photo.AndroidPhotoBackend

internal enum class BenchmarkMode(val title: String, val providers: List<BenchmarkProvider>) {
    CPU("CPU", listOf(BenchmarkProvider.CPU)),
    HTP("QNN HTP", listOf(BenchmarkProvider.HTP)),
    COMPARE("CPU и QNN HTP", BenchmarkProvider.entries),
}

internal enum class BenchmarkProvider(val title: String) {
    CPU("CPU"),
    HTP("QNN HTP"),
}

internal data class BenchmarkReport(
    val json: String,
    val sections: List<String>,
    val fileName: String = "drone-qnn-comparison.json",
)

internal object QnnBenchmark {
    private const val TAG = "QnnBenchmark"
    private const val QNN_EP = "QNNExecutionProvider"
    private const val QNN_LIBRARY_FILE = "libonnxruntime_providers_qnn.so"
    private const val DSP_LIBRARY_PATH = "ADSP_LIBRARY_PATH"
    private const val CONFIDENCE = 0.5f
    private const val BORDERLINE = 0.05f
    private const val MATCH_IOU = 0.90f
    const val WARMUPS = 4
    private const val SAMPLES = 20

    private fun reportMetadata() = JSONObject()
        .put("manufacturer", Build.MANUFACTURER)
        .put("device", Build.MODEL)
        .put("android_api", Build.VERSION.SDK_INT)
        .put("android_release", Build.VERSION.RELEASE)
        .put("android_build", Build.ID)
        .put("supported_abis", JSONArray(Build.SUPPORTED_ABIS.toList()))
        .put("supported_64_bit_abis", JSONArray(Build.SUPPORTED_64_BIT_ABIS.toList()))
        .put("soc_model", if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL else JSONObject.NULL)
        .put("soc_manufacturer", if (Build.VERSION.SDK_INT >= 31) Build.SOC_MANUFACTURER else JSONObject.NULL)
        .put("app_version", BuildConfig.VERSION_NAME)
        .put("build_git_sha", BuildConfig.BUILD_GIT_SHA)
        .put("build_git_dirty", BuildConfig.BUILD_GIT_DIRTY)
        .put("model_sha256", BuildConfig.DRONE_MODEL_SHA256)
        .put("qnn_plugin", BuildConfig.QNN_PLUGIN_VERSION)
        .put("qnn_runtime", BuildConfig.QNN_RUNTIME_VERSION)
        .put("confidence_threshold", CONFIDENCE)
        .put("confidence_rule", "strictly_greater")
        .put("timing_scope", "runRaw (ORT inference, tensor binding and copies)")
        .put("intra_op_threads", YoloEngineOptions().intraOpThreads)
        .put("input_tensor_type", "float32")

    private class SustainedStopped : Exception()
    private data class SustainedInput(val name: String, val sha256: String, val tensor: FloatArray)

    // The ViewModel serializes all calls and cleanup on DetectorWorker.
    class Runner(private val context: Context) {
        private var htpSession: SessionRun? = null

        fun releaseHtp(): String? {
            val session = htpSession ?: return null
            val failure = session.close()
            if (failure == null) htpSession = null
            return failure
        }

        fun run(
            photos: List<Uri>,
            mode: BenchmarkMode,
            coldHtp: Boolean,
            checkActive: () -> Unit,
            progress: (String) -> Unit,
        ): BenchmarkReport {
            val root = reportMetadata()
                .put("schema_version", 3)
                .put("mode", mode.name)
                .put("cold_htp_requested", coldHtp)
                .put("near_threshold_delta", BORDERLINE)
                .put("box_match_min_iou", MATCH_IOU)
                .put("warmups_per_image_per_backend", WARMUPS)
                .put("samples_per_image_per_backend", SAMPLES)
            val sessions = mutableListOf<SessionRun>()
            var completed = false
            val images = JSONArray()
            val sections = mutableListOf<String>()
            try {
                checkActive()
                progress("Проверка модели")
                val model = verifiedModel(context)
                val env = OrtEnvironment.getEnvironment()
                root.put("ort_version", env.version)
                for (provider in mode.providers) {
                    checkActive()
                    val started = System.nanoTime()
                    if (provider == BenchmarkProvider.HTP && (coldHtp || htpSession?.canReuse == false)) {
                        val issue = releaseHtp()
                        check(issue == null) { "Не удалось освободить сессию HTP. $issue" }
                    }
                    val cached = if (provider == BenchmarkProvider.HTP) htpSession else null
                    val session = cached ?: SessionRun(provider)
                    sessions += session
                    session.beginRun(reused = cached != null)
                    if (cached == null) {
                        if (provider == BenchmarkProvider.HTP) htpSession = session
                        progress("Создание сессии ${provider.title}")
                        session.open(context, env, model)
                    } else {
                        progress("Повторное использование сессии HTP")
                    }
                    session.initializationMs = (System.nanoTime() - started) / 1e6
                    checkActive()
                }
                AndroidPhotoBackend(context).use { backend ->
                    photos.forEachIndexed { index, uri ->
                        checkActive()
                        progress("Кадр ${index + 1} из ${photos.size}")
                        val name = attempt("photo_name", { _ -> null }) { displayName(context, uri) }
                            ?: "Кадр ${index + 1}"
                        val image = JSONObject().put("index", index + 1).put("name", name)
                        val text = mutableListOf(name)
                        val prepared = attempt("photo_prepare", { failure ->
                            image.put("error", failure.json())
                            text += failure.text
                            null
                        }) {
                            val source = sessions.firstNotNullOfOrNull { it.engine }
                            source?.let {
                                val bitmap = backend.load(uri.toString())
                                try {
                                    it.preprocessOnly(bitmap.toArgbImage())
                                } finally {
                                    backend.discard(bitmap)
                                }
                            }
                        }
                        val cpuAndHtp = if (prepared == null) {
                            if (!image.has("error")) text += "Сессия для обработки кадра недоступна."
                            emptyList()
                        } else {
                            val (input, letterbox) = prepared
                            image.put("width_px", letterbox.srcWidth).put("height_px", letterbox.srcHeight)
                                .put("input_shape", JSONArray(listOf(1, 3, letterbox.inputSize, letterbox.inputSize)))
                                .put("input_sha256", tensorHash(input))
                            sessions.map { session -> session.measure(input, letterbox, text, checkActive) }
                        }
                        image.put("runs", JSONArray(cpuAndHtp.map { it.json() }))
                        val cpu = cpuAndHtp.firstOrNull { it.provider == BenchmarkProvider.CPU }?.measurement
                        val htp = cpuAndHtp.firstOrNull { it.provider == BenchmarkProvider.HTP }?.measurement
                        if (cpu != null && htp != null) {
                            val comparison = compare(cpu.boxes, htp.boxes)
                            image.put("comparison", comparison)
                            text += "Решение ${agreement(comparison.getBoolean("same_decision"))}, " +
                                "рамки ${agreement(comparison.getBoolean("same_boxes"))}."
                            if (sessions.any { it.confirmedHtp }) {
                                comparison.put("speedup_p50", cpu.timing.median / htp.timing.median)
                                comparison.put("speedup_p95", checkNotNull(cpu.timing.p95) / checkNotNull(htp.timing.p95))
                            }
                        } else {
                            image.put("comparison", JSONObject.NULL)
                        }
                        images.put(image)
                        sections += text.joinToString("\n")
                    }
                }
                checkActive()
                completed = true
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                val failure = failure("benchmark_setup", e)
                root.put("error", failure.json())
                sections.add(0, failure.text)
            } catch (e: LinkageError) {
                val failure = failure("benchmark_setup", e)
                root.put("error", failure.json())
                sections.add(0, failure.text)
            } finally {
                for (session in sessions.asReversed()) {
                    if (session.provider == BenchmarkProvider.CPU) {
                        session.close()
                    } else if (completed && session.canReuse) {
                        session.retainedForReuse = true
                    } else {
                        releaseHtp()
                    }
                }
            }
            root.put("sessions", JSONArray(sessions.map { it.json() }))
            root.put("images", images)
            return BenchmarkReport(root.toString(2), sessions.map { it.summary() } + sections)
        }
        suspend fun runSustained(
            photos: List<Uri>,
            provider: BenchmarkProvider,
            fps: Int,
            stopRequested: () -> Boolean,
            checkActive: () -> Unit,
            progress: (String) -> Unit,
        ): BenchmarkReport {
            val measurement = SustainedRun(FrameSchedule(fps))
            val report = reportMetadata()
                .put("schema_version", 1)
                .put("mode", "SUSTAINED")
                .put("backend", provider.name)
                .put("target_duration_s", SUSTAINED_SECONDS)
                .put("target_fps", fps)
                .put("input_order", "input_sha256_then_name")
                .put("schedule", "fixed_rate_repeat_inputs_skip_expired_slots")
                .put("thermal_status_before_preparation", thermalStatus(context) ?: JSONObject.NULL)
                .put("ordered_inputs", JSONArray())
                .put("warmup_frames", 0)
            val session = SessionRun(provider)
            var stage = "prepare"
            var error: Failure? = null
            var outcome = "completed"

            fun stopIfRequested() {
                checkActive()
                if (stopRequested()) throw SustainedStopped()
            }

            try {
                stopIfRequested()
                require(photos.size in 1..MAX_SUSTAINED_PHOTOS) { "Выберите от 1 до $MAX_SUSTAINED_PHOTOS кадров" }
                // Start both variants without a retained HTP graph from the short comparison.
                check(releaseHtp() == null) { "Не удалось освободить предыдущую сессию HTP" }
                val model = verifiedModel(context)
                stopIfRequested()
                val env = OrtEnvironment.getEnvironment()
                report.put("ort_version", env.version)
                stage = "session_create"
                progress("Создание сессии ${provider.title}")
                val started = System.nanoTime()
                session.open(context, env, model)
                session.initializationMs = (System.nanoTime() - started) / 1e6
                stopIfRequested()
                val engine = session.engine
                if (engine == null) {
                    outcome = "error"
                } else {
                    stage = "photo_prepare"
                    progress("Подготовка кадров")
                    val inputs = AndroidPhotoBackend(context).use { backend ->
                        photos.map { uri ->
                            stopIfRequested()
                            val bitmap = backend.load(uri.toString())
                            val tensor = try {
                                engine.preprocessOnly(bitmap.toArgbImage()).first
                            } finally {
                                backend.discard(bitmap)
                            }
                            val name = attempt("photo_name", { _ -> null }) { displayName(context, uri) }
                                ?: uri.lastPathSegment.orEmpty()
                            SustainedInput(name, tensorHash(tensor), tensor)
                        }.sortedWith(compareBy({ it.sha256 }, { it.name }))
                    }
                    report.put("ordered_inputs", JSONArray(inputs.map { input ->
                        JSONObject().put("name", input.name).put("input_sha256", input.sha256)
                    }))
                    stage = "warmup"
                    progress("Прогрев ${provider.title}")
                    repeat(maxOf(WARMUPS, inputs.size)) { index ->
                        stopIfRequested()
                        session.warmup(inputs[index % inputs.size].tensor)
                        report.put("warmup_frames", index + 1)
                    }
                    stopIfRequested()
                    stage = "htp_proof"
                    check(provider != BenchmarkProvider.HTP || session.confirmedHtp) {
                        "Профиль ORT не подтвердил запуск на HTP"
                    }
                    stage = "inference"
                    measurement.measure(context, inputs.size, stopRequested, checkActive, progress) { index ->
                        engine.runRaw(inputs[index].tensor)
                    }
                    if (measurement.stopped) outcome = "cancelled"
                }
            } catch (_: SustainedStopped) {
                outcome = "cancelled"
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                outcome = "error"
                error = failure(stage, e)
            } catch (e: LinkageError) {
                outcome = "error"
                error = failure(stage, e)
            } finally {
                // Keep ownership for cleanup retry if native session release failed.
                if (session.close() != null && provider == BenchmarkProvider.HTP) htpSession = session
            }
            val stats = measurement.json()
            report.put("outcome", outcome)
                .put("error", error?.json() ?: JSONObject.NULL)
                .put("sessions", JSONArray(listOf(session.json())))
                .put("measurement", stats)
            val status = when (outcome) {
                "completed" -> "15-минутный прогон завершён."
                "cancelled" -> "Прогон отменён. Сохранён частичный результат."
                else -> "Прогон завершился с ошибкой."
            }
            val actual = measurement.actualFps?.let { decimal(it, 2) } ?: "—"
            return BenchmarkReport(
                report.toString(2),
                listOfNotNull(
                    status,
                    session.summary(),
                    "Задано $fps кадр/с · фактически $actual кадр/с\n" +
                        "Обработано ${measurement.processed} · пропущено ${measurement.missed}",
                    error?.text,
                ),
                "drone-qnn-15min-${provider.name.lowercase(Locale.ROOT)}.json",
            )
        }

    }

    private fun verifiedModel(context: Context): File {
        val asset = BuildConfig.DRONE_MODEL_ASSET
        val target = File(File(context.noBackupFilesDir, "models"), File(asset).name)
        return ModelFiles.installVerified({ context.assets.open(asset) }, target, BuildConfig.DRONE_MODEL_SHA256)
    }

    /** Owned by the camera backend on the same ML worker as the offline pilot. */
    class CameraSession : AutoCloseable {
        private val session = SessionRun(BenchmarkProvider.HTP)
        var profileNodeEvents: Int = 0
            private set

        fun warmUp(context: Context, threads: Int, frame: CameraFrameSnapshot, confidence: Float) {
            val model = verifiedModel(context)
            session.open(context, OrtEnvironment.getEnvironment(), model, YoloEngineOptions(intraOpThreads = threads))
            check(session.engine != null) { session.setupError ?: "Не удалось открыть QNN HTP" }
            repeat(WARMUPS) {
                detect(frame, confidence)
                session.confirmAfterWarmup()
            }
            check(session.confirmedHtp) { "Профиль ORT не подтвердил QNN HTP: ${session.proofIssue}" }
            profileNodeEvents = session.confirmedNodeEvents
        }

        val inputSize: Int get() = checkNotNull(session.engine).spec.inputSize

        fun detect(frame: CameraFrameSnapshot, confidence: Float): YoloResult =
            checkNotNull(session.engine).detect(frame.image, frame.rotationDegrees,
                PostprocessConfig(confidenceThreshold = confidence))

        override fun close() {
            val issue = session.close()
            check(issue == null) { checkNotNull(issue) }
        }
    }

    private class SessionRun(val provider: BenchmarkProvider) {
        var engine: YoloOnnxEngine? = null
            private set
        private var env: OrtEnvironment? = null
        private var profileDir: File? = null
        private var registered = false
        private var sessionMs: Double? = null
        private val sessionId = UUID.randomUUID().toString()
        private var reused = false
        var initializationMs: Double? = null
        var retainedForReuse = false
        private var setupFailure: Failure? = null
        private var cleanupFailure: Failure? = null
        private var profileFailure: Failure? = null
        private var ranInference = false
        private var ranProfiledInference = false
        private var htpInferenceFailure: Failure? = null
        private var deviceCount: Int? = null
        private var npuCount: Int? = null
        private var discovery: JSONObject? = null
        private var previousDspPath: String? = null
        private var dspPathConfigured = false
        private val profileNodes = mutableMapOf<String, Int>()

        fun beginRun(reused: Boolean) {
            this.reused = reused
            ranInference = false
            retainedForReuse = false
        }

        fun open(
            context: Context, ort: OrtEnvironment, model: File, engineOptions: YoloEngineOptions = YoloEngineOptions(),
        ) {
            env = ort
            var stage = "session_create"
            try {
                if (provider == BenchmarkProvider.HTP) {
                    val platform = detectedPlatform()
                    stage = "qnn_packaging"
                    val libDir = File(context.applicationInfo.nativeLibraryDir)
                    val plugin = File(libDir, QNN_LIBRARY_FILE)
                    val nativeNames = listOf(QNN_LIBRARY_FILE, "libQnnHtp.so", "libQnnHtpPrepare.so", "libQnnSystem.so") +
                        (platform?.let { listOf("libQnnHtpV${it.hexagon}Stub.so", "libQnnHtpV${it.hexagon}Skel.so") }
                            ?: emptyList())
                    val options = mutableMapOf("backend_type" to "htp", "offload_graph_io_quantization" to "0")
                    platform?.let { options["soc_model"] = it.soc }
                    discovery = JSONObject()
                        .put("registration_name", QNN_EP)
                        .put("expected_ep_name", QNN_EP)
                        .put("registered", false)
                        .put("native_library_dir", libDir.absolutePath)
                        .put("packaged_libraries", JSONObject(nativeNames.associateWith { File(libDir, it).isFile }))
                        .put("expected_hexagon_version", platform?.hexagon ?: JSONObject.NULL)
                        .put("provider_options", JSONObject(options))
                        .put("ort_builtin_providers", JSONArray(OrtEnvironment.getAvailableProviders().map { it.name }))
                    for (name in nativeNames) {
                        val file = File(libDir, name)
                        if (!file.isFile) throw FileNotFoundException(file.absolutePath)
                    }
                    stage = "qnn_dsp_path"
                    previousDspPath = Os.getenv(DSP_LIBRARY_PATH)
                    val dspPath = (listOf(libDir.absolutePath) + previousDspPath.orEmpty().split(';'))
                        .filter { it.isNotBlank() }.distinct().joinToString(";")
                    // FastRPC finds the Hexagon skel on disk through this path, independent of the Android linker.
                    Os.setenv(DSP_LIBRARY_PATH, dspPath, true)
                    dspPathConfigured = true
                    discovery?.put("adsp_library_path", dspPath)
                    stage = "qnn_register"
                    // QNN EP 2.8.0 uses the registration name as the factory's EP name.
                    ort.registerExecutionProviderLibrary(QNN_EP, plugin.absolutePath)
                    registered = true
                    discovery?.put("registered", true)
                    stage = "qnn_devices"
                    val allDevices = ort.epDevices
                    val epNames = allDevices.map { it.epName }.distinct()
                    discovery?.put("ort_ep_names", JSONArray(epNames))
                        ?.put("ort_devices", JSONArray(allDevices.map { describeDevice(it) }))
                    Log.i(TAG, "ORT EP devices after registration: ${allDevices.map { "${it.epName}/${it.device.type}" }}")
                    val qnnDevices = allDevices.filter { it.epName == QNN_EP }
                    deviceCount = qnnDevices.size
                    check(qnnDevices.isNotEmpty()) { "ORT did not expose a $QNN_EP device. EPs: $epNames" }
                    stage = "qnn_npu_device"
                    val devices = qnnDevices.filter { it.device.type == OrtHardwareDeviceType.NPU }
                    npuCount = devices.size
                    check(devices.isNotEmpty()) { "$QNN_EP did not expose an NPU device" }
                    stage = "qnn_profile_setup"
                    profileDir = java.nio.file.Files.createTempDirectory(context.cacheDir.toPath(), "qnn-profile-").toFile()
                    val profilePrefix = File(checkNotNull(profileDir), "ort").absolutePath
                    stage = "session_create"
                    engine = YoloOnnxEngine.fromFile(model, engineOptions) { _, sessionOptions ->
                        sessionOptions.setSessionLogLevel(OrtLoggingLevel.ORT_LOGGING_LEVEL_INFO)
                        sessionOptions.addConfigEntry("session.disable_cpu_ep_fallback", "1")
                        sessionOptions.addExecutionProvider(devices, options)
                        sessionOptions.enableProfiling(profilePrefix)
                    }
                } else {
                    engine = YoloOnnxEngine.fromFile(model, engineOptions)
                }
                sessionMs = engine?.sessionCreationMs
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                setupFailure = failure(stage, e)
            } catch (e: LinkageError) {
                setupFailure = failure(stage, e)
            }
            if (setupFailure != null && provider == BenchmarkProvider.HTP) {
                discovery?.put("native_load_probes_after_failure", probeNativeLibraries())
            }
        }

        fun measure(
            input: FloatArray,
            letterbox: Letterbox,
            text: MutableList<String>,
            checkActive: () -> Unit,
        ): ImageRun {
            val active = engine ?: return ImageRun(provider, null, setupFailure)
            htpInferenceFailure?.let { return ImageRun(provider, null, it) }
            return attempt("inference", { failure ->
                if (provider == BenchmarkProvider.HTP) htpInferenceFailure = failure
                text += "${provider.title} — ${failure.text}"
                ImageRun(provider, null, failure)
            }) {
                repeat(WARMUPS) {
                    checkActive()
                    warmup(input)
                    checkActive()
                }
                val samples = ArrayList<Double>(SAMPLES)
                var last: FloatArray? = null
                repeat(SAMPLES) {
                    checkActive()
                    val start = System.nanoTime()
                    last = active.runRaw(input)
                    samples += (System.nanoTime() - start) / 1e6
                }
                checkActive()
                val raw = checkNotNull(last)
                val boxes = YoloPostprocessor(active.spec.labels).decode(
                    raw, active.spec.outputShape, letterbox, PostprocessConfig(confidenceThreshold = CONFIDENCE),
                ).filter { it.box.area > 0f }
                val maxScore = (4 * active.spec.numAnchors until raw.size)
                    .asSequence().map { raw[it] }.filter { it.isFinite() }.maxOrNull()
                val measurement = Measurement(samples, boxes, maxScore)
                val near = if (measurement.nearThreshold) " · у порога" else ""
                text += "${provider.title} — p50 ${ms(measurement.timing.median)}, " +
                    "p95 ${ms(measurement.timing.p95)} · рамок ${boxes.size} · " +
                    "макс. score ${maxScore?.let { decimal(it.toDouble(), 4) } ?: "—"}$near"
                ImageRun(provider, measurement, null)
            }
        }

        val setupError: String? get() = setupFailure?.let { "${it.stage}: ${it.text}" }
        val proofIssue: String get() = profileFailure?.text ?: "провайдеры в профиле: $profileNodes"
        val confirmedNodeEvents: Int get() = checkNotNull(profileNodes[QNN_EP]).also { check(confirmedHtp) }

        fun warmup(input: FloatArray) {
            checkNotNull(engine).runRaw(input)
            confirmAfterWarmup()
        }

        fun confirmAfterWarmup() {
            ranInference = true
            // The first successful HTP warmup supplies proof without profiling the timed samples.
            if (provider == BenchmarkProvider.HTP && !ranProfiledInference) {
                ranProfiledInference = true
                attempt("qnn_profile_read", { issue -> profileFailure = issue }) { readProfile(checkNotNull(engine)) }
            }
        }

        private fun readProfile(active: YoloOnnxEngine) {
            val file = File(active.endProfiling())
            val events = JSONArray(file.readText())
            for (i in 0 until events.length()) {
                val event = events.optJSONObject(i) ?: continue
                if (event.optString("cat") != "Node") continue
                val name = event.optJSONObject("args")?.optString("provider").orEmpty()
                if (name.isNotBlank()) profileNodes[name] = (profileNodes[name] ?: 0) + 1
            }
        }

        private val hasHtpProof: Boolean
            get() = ranProfiledInference && profileFailure == null && profileNodes.keys == setOf(QNN_EP)

        val confirmedHtp: Boolean
            get() = ranInference && hasHtpProof

        val canReuse: Boolean
            get() = engine != null && hasHtpProof && htpInferenceFailure == null && cleanupFailure == null

        private val executedProvider: String?
            get() = when {
                !ranInference -> null
                provider == BenchmarkProvider.CPU -> "CPUExecutionProvider"
                confirmedHtp -> QNN_EP
                else -> null
            }

        fun json() = JSONObject()
            .put("requested", provider.name)
            .put("session_mode", if (reused) "reused" else "cold")
            .put("session_id", if (sessionMs != null) sessionId else JSONObject.NULL)
            .put("session_creation_ms", if (reused) JSONObject.NULL else sessionMs ?: JSONObject.NULL)
            .put("initialization_ms", initializationMs ?: JSONObject.NULL)
            .put("retained_for_reuse", retainedForReuse)
            .put("profile_from_earlier_run", reused && hasHtpProof)
            .put("executed_provider", executedProvider ?: JSONObject.NULL)
            .put("inference_succeeded", ranInference)
            .put("htp_confirmed", if (provider == BenchmarkProvider.HTP) confirmedHtp else JSONObject.NULL)
            .put("cpu_ep_fallback_disabled", provider == BenchmarkProvider.HTP)
            .put("qnn_devices", deviceCount ?: JSONObject.NULL)
            .put("qnn_npu_devices", npuCount ?: JSONObject.NULL)
            .put("qnn_discovery", discovery ?: JSONObject.NULL)
            .put("profile_node_events", JSONObject(profileNodes))
            .put("setup_error", setupFailure?.json() ?: JSONObject.NULL)
            .put("profile_error", profileFailure?.json() ?: JSONObject.NULL)
            .put("cleanup_error", cleanupFailure?.json() ?: JSONObject.NULL)

        fun summary(): String {
            val status = when {
                setupFailure != null -> setupFailure?.text
                !ranInference -> "Нет успешного инференса."
                provider == BenchmarkProvider.CPU -> "Инференс выполнен на CPU."
                confirmedHtp && reused -> "HTP подтверждён профилем этой же сессии."
                confirmedHtp -> "HTP подтверждён профилем ORT."
                else -> "HTP не подтверждён. ${profileFailure?.text ?: "Провайдеры в профиле: $profileNodes"}"
            }
            val startup = if (reused) "повторное использование" else "создание сессии ${ms(sessionMs)}"
            return "${provider.title} · $startup · инициализация ${ms(initializationMs)}\n$status" +
                (cleanupFailure?.let { "\n${it.text}" } ?: "")
        }

        fun close(): String? {
            cleanupFailure = null
            retainedForReuse = false
            attempt("session_close", { issue -> cleanupFailure = issue }) {
                engine?.close()
                engine = null
                if (registered) {
                    env?.unregisterExecutionProviderLibrary(QNN_EP)
                    registered = false
                }
                if (dspPathConfigured) {
                    val path = previousDspPath
                    if (path == null) Os.unsetenv(DSP_LIBRARY_PATH) else Os.setenv(DSP_LIBRARY_PATH, path, true)
                    dspPathConfigured = false
                }
                profileDir?.deleteRecursively()
                profileDir = null
            }
            return cleanupFailure?.text
        }
    }

    private data class HtpPlatform(val soc: String, val hexagon: Int)

    private fun detectedPlatform(): HtpPlatform? {
        if (Build.VERSION.SDK_INT < 31 || "arm64-v8a" !in Build.SUPPORTED_64_BIT_ABIS) return null
        // The QNN EP 2.8.0 SoC table maps these models to their respective HTP architectures.
        return when (Build.SOC_MODEL.trim().uppercase(Locale.ROOT)) {
            "SM8650" -> HtpPlatform("SM8650", 75)
            "SM8850" -> HtpPlatform("SM8850", 81)
            else -> null
        }
    }

    private fun describeDevice(ep: OrtEpDevice): JSONObject {
        val hardware = ep.device
        return JSONObject()
            .put("ep_name", ep.epName)
            .put("ep_vendor", ep.epVendor)
            .put("ep_metadata", JSONObject(ep.epMetadata))
            .put("ep_options", JSONObject(ep.epOptions))
            .put("type", hardware.type.name)
            .put("vendor", hardware.vendor)
            .put("vendor_id", hardware.vendorId.toUInt().toLong())
            .put("device_id", hardware.deviceId.toUInt().toLong())
            .put("hardware_metadata", JSONObject(hardware.metadata))
    }

    private fun probeNativeLibraries(): JSONObject = JSONObject().apply {
        for (library in listOf("cdsprpc", "QnnSystem", "QnnHtp")) {
            val result = attempt("qnn_native_load_$library", { error ->
                JSONObject().put("loaded", false).put("error", error.text)
            }) {
                System.loadLibrary(library)
                JSONObject().put("loaded", true)
            }
            put("lib$library.so", result)
        }
    }

    private data class ImageRun(val provider: BenchmarkProvider, val measurement: Measurement?, val error: Failure?) {
        fun json() = (measurement?.json() ?: JSONObject())
            .put("requested", provider.name)
            .put("error", error?.json() ?: JSONObject.NULL)
    }

    private data class Measurement(val times: List<Double>, val boxes: List<YoloDetection>, val maxScore: Float?) {
        val timing = checkNotNull(durationSummary(times))
        val nearThreshold = maxScore?.let { abs(it - CONFIDENCE) <= BORDERLINE } ?: false

        fun json() = JSONObject()
            .put("p50_ms", timing.median)
            .put("p95_ms", timing.p95 ?: JSONObject.NULL)
            .put("samples_ms", JSONArray(times))
            .put("max_raw_class_score", maxScore ?: JSONObject.NULL)
            .put("near_threshold", nearThreshold)
            .put("detected", boxes.isNotEmpty())
            .put("boxes", JSONArray(boxes.map { detection ->
                with(detection.box) {
                    JSONObject()
                        .put("class_id", detection.classId)
                        .put("label", detection.label)
                        .put("score", detection.confidence)
                        .put("xyxy", JSONArray(listOf(left, top, right, bottom)))
                }
            }))
    }

    private fun compare(cpu: List<YoloDetection>, htp: List<YoloDetection>): JSONObject {
        val pairs = buildList {
            for ((i, first) in cpu.withIndex()) {
                for ((j, second) in htp.withIndex()) {
                    if (first.classId != second.classId) continue
                    val iou = first.box.iou(second.box)
                    if (iou >= MATCH_IOU) add(Triple(i, j, iou))
                }
            }
        }.sortedByDescending { it.third }
        val matchedCpu = mutableSetOf<Int>()
        val matchedHtp = mutableSetOf<Int>()
        val matches = JSONArray()
        for ((i, j, iou) in pairs) {
            if (i in matchedCpu || j in matchedHtp) continue
            matchedCpu += i
            matchedHtp += j
            matches.put(JSONObject().put("cpu_index", i).put("htp_index", j).put("iou", iou))
        }
        return JSONObject()
            .put("same_decision", cpu.isNotEmpty() == htp.isNotEmpty())
            .put("same_boxes", matches.length() == cpu.size && matches.length() == htp.size)
            .put("matched_boxes", matches)
    }

    private fun displayName(context: Context, uri: Uri): String? {
        if (uri.scheme == "file") return uri.lastPathSegment
        return context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
    }

    private fun tensorHash(input: FloatArray): String {
        val bytes = ByteBuffer.allocate(input.size * Float.SIZE_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        bytes.asFloatBuffer().put(input)
        return bytes.array().inputStream().use(ModelFiles::sha256)
    }

    private data class Failure(val stage: String, val text: String) {
        fun json() = JSONObject().put("stage", stage).put("message", text)
    }

    private fun failure(stage: String, error: Throwable): Failure {
        Log.e(TAG, stage, error)
        return Failure(stage, generateSequence(error) { it.cause }.take(5).joinToString("\n") {
            "${it.javaClass.simpleName}: ${it.message.orEmpty()}"
        })
    }

    private inline fun <T> attempt(stage: String, recover: (Failure) -> T, block: () -> T): T = try {
        block()
    } catch (e: Exception) {
        if (e is CancellationException) throw e
        recover(failure(stage, e))
    } catch (e: LinkageError) {
        recover(failure(stage, e))
    }

    private fun agreement(agrees: Boolean) = if (agrees) "совпали" else "различаются"
    private fun ms(value: Double?) = value?.let { "${decimal(it, 1)} мс" } ?: "—"
    private fun decimal(value: Double, digits: Int) = String.format(Locale.US, "%.${digits}f", value)
}
