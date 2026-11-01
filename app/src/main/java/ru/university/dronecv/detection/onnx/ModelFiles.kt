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
     * Копирует модель из [source] в [target] атомарно (через временный файл), проверяя SHA-256.
     * Если [target] уже установлен с тем же хешем (метка `<target>.sha256`), копирование пропускается.
     * При несовпадении хеша файл не устанавливается и бросается [ModelIntegrityException].
     */
    fun installVerified(source: () -> InputStream, target: File, expectedSha256: String): File {
        val expected = expectedSha256.lowercase()
        val marker = File(target.parentFile, target.name + ".sha256")
        if (target.isFile && marker.isFile && marker.readText().trim() == expected) return target
        target.parentFile?.mkdirs()
        val tmp = File(target.parentFile, target.name + ".part")
        val md = MessageDigest.getInstance("SHA-256")
        source().use { input ->
            tmp.outputStream().use { out ->
                val buf = ByteArray(1 shl 16)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                    out.write(buf, 0, n)
                }
            }
        }
        val actual = md.digest().joinToString("") { "%02x".format(it) }
        if (actual != expected) {
            tmp.delete()
            throw ModelIntegrityException("Model SHA-256 mismatch: expected $expected, got $actual")
        }
        marker.delete()
        if (!tmp.renameTo(target)) {
            target.delete()
            if (!tmp.renameTo(target)) {
                tmp.delete()
                throw java.io.IOException("Cannot move model to ${target.absolutePath}")
            }
        }
        marker.writeText(expected)
        return target
    }
}
