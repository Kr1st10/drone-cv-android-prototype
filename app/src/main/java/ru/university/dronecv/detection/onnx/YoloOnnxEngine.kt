package ru.university.dronecv.detection.onnx

import ai.onnxruntime.OnnxJavaType
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtException
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import ru.university.dronecv.detection.yolo.ArgbImage
import ru.university.dronecv.detection.yolo.InferenceException
import ru.university.dronecv.detection.yolo.Letterbox
import ru.university.dronecv.detection.yolo.ModelFormatException
import ru.university.dronecv.detection.yolo.ModelNotFoundException
import ru.university.dronecv.detection.yolo.PostprocessConfig
import ru.university.dronecv.detection.yolo.YoloDetection
import ru.university.dronecv.detection.yolo.YoloModelSpec
import ru.university.dronecv.detection.yolo.YoloPostprocessor
import ru.university.dronecv.detection.yolo.YoloPreprocessor

/** Параметры движка: потоки ONNX Runtime и пороги постобработки. */
data class YoloEngineOptions(
    /** Число потоков intra-op; 0 — выбор ONNX Runtime. */
    val intraOpThreads: Int = 2,
    val postprocess: PostprocessConfig = PostprocessConfig(),
)

/** Результат одного кадра: обнаружения в пикселях повёрнутого кадра и замеры времени. */
data class YoloResult(
    val imageWidth: Int,
    val imageHeight: Int,
    val detections: List<YoloDetection>,
    val letterbox: Letterbox,
    val preprocessMs: Double,
    val inferenceMs: Double,
    val postprocessMs: Double,
)

/**
 * Локальный инференс YOLO через ONNX Runtime (CPU). Не зависит от Android SDK: один и тот же код
 * работает в приложении (`onnxruntime-android`) и в JVM-тестах (`onnxruntime`).
 *
 * Потокобезопасность: вызовы [detect] сериализуются внутренней блокировкой; [close] дожидается
 * текущего инференса и освобождает сессию. Метод блокирующий — не вызывать с главного потока.
 */
class YoloOnnxEngine private constructor(
    private val env: OrtEnvironment,
    private val session: OrtSession,
    val spec: YoloModelSpec,
    private val options: YoloEngineOptions,
) : AutoCloseable {

    private val lock = Any()
    private var closed = false
    private val preprocessor = YoloPreprocessor(spec.inputSize)
    private val postprocessor = YoloPostprocessor(spec.labels)
    private val inputArray = FloatArray(preprocessor.tensorSize)
    private val inputBuffer: FloatBuffer = ByteBuffer
        .allocateDirect(preprocessor.tensorSize * Float.SIZE_BYTES)
        .order(ByteOrder.nativeOrder())
        .asFloatBuffer()
    private val outputArray = FloatArray((4 + spec.labels.size) * spec.numAnchors)

    /** Выполняет обнаружение. [rotationDegrees] — поворот по часовой стрелке до «вертикального» кадра. */
    fun detect(
        image: ArgbImage,
        rotationDegrees: Int = 0,
        postprocess: PostprocessConfig = options.postprocess,
    ): YoloResult = synchronized(lock) {
        check(!closed) { "YoloOnnxEngine is closed" }
        val t0 = System.nanoTime()
        val lb = preprocessor.preprocess(image, rotationDegrees, inputArray)
        val t1 = System.nanoTime()
        val raw = runModel()
        val t2 = System.nanoTime()
        val detections = postprocessor.decode(raw, spec.outputShape, lb, postprocess)
        val t3 = System.nanoTime()
        YoloResult(lb.srcWidth, lb.srcHeight, detections, lb, ms(t1 - t0), ms(t2 - t1), ms(t3 - t2))
    }

    /** Сырой выход модели `[1, 4+nc, N]` для заранее подготовленного тензора (для проверок паритета). */
    fun runRaw(input: FloatArray): FloatArray = synchronized(lock) {
        check(!closed) { "YoloOnnxEngine is closed" }
        require(input.size == inputArray.size) { "input.size=${input.size}, expected ${inputArray.size}" }
        input.copyInto(inputArray)
        runModel().copyOf()
    }

    /** Предобработка без инференса (для проверок паритета тензора с Python-эталоном). */
    fun preprocessOnly(image: ArgbImage, rotationDegrees: Int = 0): Pair<FloatArray, Letterbox> {
        val out = FloatArray(preprocessor.tensorSize)
        val lb = YoloPreprocessor(spec.inputSize).preprocess(image, rotationDegrees, out)
        return out to lb
    }

    private fun runModel(): FloatArray {
        inputBuffer.clear()
        inputBuffer.put(inputArray)
        inputBuffer.flip()
        try {
            OnnxTensor.createTensor(env, inputBuffer, spec.inputShape).use { tensor ->
                session.run(mapOf(spec.inputName to tensor)).use { result ->
                    val out = result.get(spec.outputName).orElse(null) as? OnnxTensor
                        ?: throw InferenceException("Model returned no tensor '${spec.outputName}'")
                    val shape = (out.info as TensorInfo).shape
                    if (!shape.contentEquals(spec.outputShape)) {
                        throw InferenceException(
                            "Output shape ${shape.contentToString()} != expected ${spec.outputShape.contentToString()}"
                        )
                    }
                    val fb = out.floatBuffer
                    if (fb.remaining() != outputArray.size) {
                        throw InferenceException("Output has ${fb.remaining()} values, expected ${outputArray.size}")
                    }
                    fb.get(outputArray)
                }
            }
        } catch (e: OrtException) {
            throw InferenceException("ONNX Runtime inference failed: ${e.message}", e)
        }
        return outputArray
    }

    override fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            session.close() // OrtEnvironment — общий синглтон процесса, его не закрываем.
        }
    }

    val isClosed: Boolean get() = synchronized(lock) { closed }

    companion object {
        /** Создаёт движок из файла ONNX (ONNX Runtime отображает файл в память). */
        fun fromFile(file: File, options: YoloEngineOptions = YoloEngineOptions()): YoloOnnxEngine {
            if (!file.isFile) throw ModelNotFoundException("ONNX model not found: ${file.absolutePath}")
            return create(options) { env, so -> env.createSession(file.absolutePath, so) }
        }

        /** Создаёт движок из байтов ONNX. */
        fun fromBytes(bytes: ByteArray, options: YoloEngineOptions = YoloEngineOptions()): YoloOnnxEngine =
            create(options) { env, so -> env.createSession(bytes, so) }

        private fun create(
            options: YoloEngineOptions,
            open: (OrtEnvironment, OrtSession.SessionOptions) -> OrtSession,
        ): YoloOnnxEngine {
            val env = OrtEnvironment.getEnvironment()
            val session = try {
                OrtSession.SessionOptions().use { so ->
                    so.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
                    if (options.intraOpThreads > 0) so.setIntraOpNumThreads(options.intraOpThreads)
                    so.setInterOpNumThreads(1)
                    so.setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL)
                    so.addConfigEntry("session.intra_op.allow_spinning", "0")
                    so.addConfigEntry("session.inter_op.allow_spinning", "0")
                    open(env, so)
                }
            } catch (e: OrtException) {
                throw InferenceException("Failed to create ONNX Runtime session: ${e.message}", e)
            }
            try {
                return YoloOnnxEngine(env, session, inspect(session), options)
            } catch (e: Throwable) {
                session.close()
                throw e
            }
        }

        private fun inspect(session: OrtSession): YoloModelSpec {
            if (session.numInputs != 1L || session.numOutputs != 1L) {
                throw ModelFormatException("Expected 1 input and 1 output, got ${session.numInputs}/${session.numOutputs}")
            }
            val (inName, inNode) = session.inputInfo.entries.single().let { it.key to it.value }
            val (outName, outNode) = session.outputInfo.entries.single().let { it.key to it.value }
            val inInfo = inNode.info as? TensorInfo ?: throw ModelFormatException("Input '$inName' is not a tensor")
            val outInfo = outNode.info as? TensorInfo ?: throw ModelFormatException("Output '$outName' is not a tensor")
            if (inInfo.type != OnnxJavaType.FLOAT || outInfo.type != OnnxJavaType.FLOAT) {
                throw ModelFormatException("Expected float32 tensors, got ${inInfo.type} -> ${outInfo.type}")
            }
            val names = try {
                session.metadata.customMetadata["names"]
            } catch (e: OrtException) {
                null
            }
            return YoloModelSpec.validate(inName, inInfo.shape, outName, outInfo.shape, names)
        }

        private fun ms(nanos: Long) = nanos / 1_000_000.0
    }
}
