package ru.university.dronecv.diagnostics

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

internal class DiagnosticExporter<D>(
    private val lock: Any,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher,
    private val currentReport: () -> DiagnosticReport?,
    private val status: (String) -> Unit,
    private val write: suspend (DiagnosticReport, D) -> Unit,
) {
    private var latest: Any? = null

    fun export(destination: D) {
        val operation = Any()
        val saved = synchronized(lock) {
            val report = currentReport() ?: return
            latest = operation
            status("Сохранение…")
            report
        }
        scope.launch(io) {
            val result = try {
                write(saved, destination)
                "Отчёт сохранён"
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                "Ошибка экспорта: ${e.message ?: e.javaClass.simpleName}"
            }
            synchronized(lock) {
                if (currentReport() === saved && latest === operation) status(result)
            }
        }
    }
}
