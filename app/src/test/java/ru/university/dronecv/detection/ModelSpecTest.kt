package ru.university.dronecv.detection

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.university.dronecv.detection.onnx.ModelFiles
import ru.university.dronecv.detection.yolo.ModelFormatException
import ru.university.dronecv.detection.yolo.ModelIntegrityException
import ru.university.dronecv.detection.yolo.YoloModelSpec

/** Проверка форм тензоров, разбора меток и целостности файла модели. */
class ModelSpecTest {
    private fun validate(inp: LongArray, out: LongArray, names: String? = "{0: 'drone'}") =
        YoloModelSpec.validate("images", inp, "output0", out, names)

    @Test
    fun acceptsExportedYolo11sShapes() {
        val spec = validate(longArrayOf(1, 3, 640, 640), longArrayOf(1, 5, 8400))
        assertEquals(640, spec.inputSize); assertEquals(8400, spec.numAnchors)
        assertEquals(listOf("drone"), spec.labels)
        assertEquals(listOf(1L, 3L, 640L, 640L), spec.inputShape.toList())
        assertEquals(listOf(1L, 5L, 8400L), spec.outputShape.toList())
    }

    @Test
    fun acceptsOtherStaticSizes() {
        assertEquals(33600, validate(longArrayOf(1, 3, 1280, 1280), longArrayOf(1, 5, 33600)).numAnchors)
    }

    @Test
    fun rejectsUnexpectedShapes() {
        val bad = listOf(
            longArrayOf(1, 3, -1, -1) to longArrayOf(1, 5, 8400),       // динамический вход
            longArrayOf(1, 3, 640, 480) to longArrayOf(1, 5, 6300),     // не квадрат
            longArrayOf(1, 640, 640, 3) to longArrayOf(1, 5, 8400),     // NHWC
            longArrayOf(1, 3, 640, 640) to longArrayOf(1, 300, 6),      // экспорт с NMS
            longArrayOf(1, 3, 640, 640) to longArrayOf(1, 8400, 5),     // транспонированный выход
            longArrayOf(1, 3, 640, 640) to longArrayOf(1, 4, 8400),     // нет классов
        )
        for ((i, o) in bad) assertThrows(ModelFormatException::class.java) { validate(i, o) }
    }

    @Test
    fun labelsFromMetadata() {
        assertEquals(mapOf(0 to "drone", 1 to "bird"), YoloModelSpec.parseNames("{0: 'drone', 1: \"bird\"}"))
        assertEquals(listOf("class_0"), validate(longArrayOf(1, 3, 640, 640), longArrayOf(1, 5, 8400), null).labels)
        assertThrows(ModelFormatException::class.java) {
            validate(longArrayOf(1, 3, 640, 640), longArrayOf(1, 5, 8400), "{0: 'drone', 1: 'bird'}")
        }
    }

    @Test
    fun installVerifiedChecksSha256() {
        val dir = Files.createTempDirectory("model").toFile()
        val data = "not a real model".toByteArray()
        val sha = ModelFiles.sha256(data.inputStream())
        assertEquals("SHA-256 hex", 64, sha.length)
        val target = File(dir, "m.onnx")
        ModelFiles.installVerified({ data.inputStream() }, target, sha)
        assertTrue(target.isFile); assertEquals(sha, ModelFiles.sha256(target))
        // Повторная установка с тем же хешем не читает источник.
        ModelFiles.installVerified({ error("must not be read") }, target, sha)

        val other = File(dir, "bad.onnx")
        assertThrows(ModelIntegrityException::class.java) {
            ModelFiles.installVerified({ data.inputStream() }, other, "0".repeat(64))
        }
        assertFalse(other.exists()); assertFalse(File(dir, "bad.onnx.part").exists())
        dir.deleteRecursively()
    }
    @Test
    fun corruptCachedModelIsReplacedDespiteMatchingMarker() {
        val dir = Files.createTempDirectory("model-corrupt").toFile()
        try {
            val data = "verified model".toByteArray()
            val sha = ModelFiles.sha256(data.inputStream())
            val target = File(dir, "m.onnx")
            target.writeText("corrupt")
            File(dir, "m.onnx.sha256").writeText(sha)
            ModelFiles.installVerified({ data.inputStream() }, target, sha)
            assertEquals(sha, ModelFiles.sha256(target))
        } finally { dir.deleteRecursively() }
    }

    @Test
    fun failedInstallPreservesTargetAndRemovesTemporaryFile() {
        val dir = Files.createTempDirectory("model-failure").toFile()
        try {
            val target = File(dir, "m.onnx").apply { writeText("old model") }
            val expected = ModelFiles.sha256("new model".byteInputStream())
            assertThrows(ModelIntegrityException::class.java) {
                ModelFiles.installVerified({ "wrong model".byteInputStream() }, target, expected)
            }
            assertThrows(java.io.IOException::class.java) {
                ModelFiles.installVerified({ object : java.io.InputStream() {
                    override fun read(): Int = throw java.io.IOException("source failed")
                } }, target, expected)
            }
            assertEquals("old model", target.readText())
            assertEquals(listOf("m.onnx"), dir.list()!!.toList())
        } finally { dir.deleteRecursively() }
    }

}
