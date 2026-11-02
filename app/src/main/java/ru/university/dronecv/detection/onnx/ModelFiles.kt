package ru.university.dronecv.detection.onnx

import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import ru.university.dronecv.detection.yolo.ModelIntegrityException

/** Проверка целостности и установка файла модели (без зависимостей от Android). */
object ModelFiles {

    fun sha256(file: File): String = file.inputStream().use { sha256(it) }

    fun sha256(input: InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(1 shl 16)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /**
     * Проверяет установленный файл по фактическому SHA-256; повреждённый кеш восстанавливает из [source].
     * Установка атомарна: исходный файл сохраняется при ошибке чтения или несовпадении хеша.
     */
    @Synchronized
    fun installVerified(source: () -> InputStream, target: File, expectedSha256: String): File {
        val expected = expectedSha256.lowercase()
        require(expected.matches(Regex("[0-9a-f]{64}"))) { "Expected a SHA-256 hex digest" }
        if (target.isFile && sha256(target) == expected) return target
        val parent = target.absoluteFile.parentFile!!
        parent.mkdirs()
        val tmp = File.createTempFile(target.name + ".", ".part", parent)
        try {
            source().use { input -> tmp.outputStream().use { input.copyTo(it) } }
            val actual = sha256(tmp)
            if (actual != expected) {
                throw ModelIntegrityException("Model SHA-256 mismatch: expected $expected, got $actual")
            }
            java.nio.file.Files.move(
                tmp.toPath(), target.toPath(),
                java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                java.nio.file.StandardCopyOption.REPLACE_EXISTING,
            )
            return target
        } finally {
            tmp.delete()
        }
    }
}
