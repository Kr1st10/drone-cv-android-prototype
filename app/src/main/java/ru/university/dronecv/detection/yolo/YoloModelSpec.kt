package ru.university.dronecv.detection.yolo

/**
 * Проверенная структура модели YOLO (детекция, экспорт Ultralytics без NMS):
 * вход `float32 [1, 3, S, S]`, выход `float32 [1, 4 + nc, N]`, `N = (S/8)² + (S/16)² + (S/32)²`.
 */
data class YoloModelSpec(
    val inputName: String,
    val outputName: String,
    val inputSize: Int,
    val numAnchors: Int,
    val labels: List<String>,
) {
    val inputShape: LongArray get() = longArrayOf(1, 3, inputSize.toLong(), inputSize.toLong())
    val outputShape: LongArray get() = longArrayOf(1, 4L + labels.size, numAnchors.toLong())

    companion object {
        /**
         * Проверяет формы тензоров и метки классов. Бросает [ModelFormatException], если модель
         * не соответствует ожидаемой структуре (например, экспорт с NMS, динамические оси, сегментация).
         *
         * @param namesMetadata значение метаданных ONNX `names`, например `{0: 'drone'}`.
         */
        fun validate(
            inputName: String,
            inputShape: LongArray,
            outputName: String,
            outputShape: LongArray,
            namesMetadata: String?,
        ): YoloModelSpec {
            if (inputShape.size != 4 || inputShape[0] != 1L || inputShape[1] != 3L ||
                inputShape[2] <= 0 || inputShape[2] != inputShape[3] || inputShape[2] % 32 != 0L
            ) {
                throw ModelFormatException(
                    "Unsupported input shape ${inputShape.contentToString()}, expected static [1, 3, S, S], S % 32 == 0"
                )
            }
            val s = inputShape[2].toInt()
            val expectedAnchors = (s / 8) * (s / 8) + (s / 16) * (s / 16) + (s / 32) * (s / 32)
            if (outputShape.size != 3 || outputShape[0] != 1L || outputShape[1] < 5 ||
                outputShape[2] != expectedAnchors.toLong()
            ) {
                throw ModelFormatException(
                    "Unsupported output shape ${outputShape.contentToString()}, expected [1, 4+nc, $expectedAnchors] " +
                        "(YOLO detect head exported with nms=False)"
                )
            }
            val nc = (outputShape[1] - 4).toInt()
            val parsed = namesMetadata?.let(::parseNames).orEmpty()
            val labels = if (parsed.isEmpty()) {
                List(nc) { "class_$it" }
            } else {
                if (parsed.keys != (0 until nc).toSet()) {
                    throw ModelFormatException("Metadata names $parsed do not match $nc output classes")
                }
                List(nc) { parsed.getValue(it) }
            }
            return YoloModelSpec(inputName, outputName, s, expectedAnchors, labels)
        }

        private val NAME_ENTRY = Regex("""(\d+)\s*:\s*['"]([^'"]*)['"]""")

        /** Разбор Python-словаря Ultralytics `{0: 'drone', 1: 'bird'}`. */
        fun parseNames(metadata: String): Map<Int, String> =
            NAME_ENTRY.findAll(metadata).associate { it.groupValues[1].toInt() to it.groupValues[2] }
    }
}
