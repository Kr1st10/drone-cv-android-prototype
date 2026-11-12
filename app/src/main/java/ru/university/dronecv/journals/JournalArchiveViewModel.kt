package ru.university.dronecv.journals

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.coroutineContext

/** One archive monitor for both Activity-scoped recording ViewModels. */
object JournalArchives {
    @Volatile private var instance: JournalArchive? = null
    fun get(app: Application): JournalArchive = instance ?: synchronized(this) {
        instance ?: JournalArchive({ app.filesDir }).also { instance = it }
    }
}

data class ArchiveUi(val inventory: JournalInventory? = null, val busy: Boolean = false,
                     val message: String? = null, val error: String? = null, val loadError: String? = null)

/** Owns the selected file across rotation and mode switches, including the system picker interval. */
class JournalArchiveViewModel(private val app: Application) : AndroidViewModel(app) {
    private val store = JournalArchives.get(app)
    val policy: JournalPolicy get() = store.policy
    private var pending: JournalArchive.Export? = null
    private val mutableUi = MutableStateFlow(ArchiveUi())
    val ui = mutableUi.asStateFlow()

    fun refresh() = viewModelScope.launch(Dispatchers.IO) {
        try { mutableUi.update { it.copy(inventory = store.inventory(), loadError = null) } }
        catch (e: Exception) { mutableUi.update { it.copy(loadError = "Не удалось прочитать архив: ${e.message}") } }
    }
    fun select(id: String, launchPicker: (String) -> Unit) {
        if (mutableUi.value.busy) return
        mutableUi.update { it.copy(busy = true, message = null, error = null) }
        viewModelScope.launch(Dispatchers.IO) {
            var selected: JournalArchive.Export? = null
            try {
                selected = store.selectExport(id)
                withContext(Dispatchers.Main.immediate) {
                    pending = selected
                    launchPicker(id)
                    selected = null // Ownership is now in pending, until the picker callback.
                }
            } catch (e: Exception) {
                withContext(NonCancellable + Dispatchers.Main.immediate) {
                    pending?.close(); pending = null
                    mutableUi.update { it.copy(busy = false, error = "Не удалось выбрать журнал: ${e.message}") }
                }
            } finally { selected?.close() }
        }
    }
    fun export(uri: Uri?) {
        val selected = pending ?: return
        pending = null
        if (uri == null) {
            selected.close()
            mutableUi.update { it.copy(busy = false, message = "Экспорт отменён") }
            refresh(); return
        }
        // The completion hook also releases a lease when cancellation precedes coroutine execution.
        val job = viewModelScope.launch(Dispatchers.IO) {
            try {
                selected.copy({ checkNotNull(app.contentResolver.openOutputStream(uri)) { "Не удалось открыть файл" } },
                    { coroutineContext.ensureActive() })
                mutableUi.update { it.copy(message = "Журнал экспортирован", error = null) }
            } catch (e: Exception) {
                mutableUi.update { it.copy(error = "Экспорт не завершён: ${e.message}") }
            } finally {
                selected.close()
                mutableUi.update { it.copy(busy = false) }
                refresh()
            }
        }
        job.invokeOnCompletion { selected.close() }
    }
    fun delete(id: String, confirmed: Boolean) {
        if (mutableUi.value.busy) return
        mutableUi.update { it.copy(busy = true, message = null, error = null) }
        viewModelScope.launch(Dispatchers.IO) {
            try {
                store.delete(id, allowUnexported = confirmed)
                mutableUi.update { it.copy(message = "Журнал удалён") }
            } catch (e: Exception) { mutableUi.update { it.copy(error = "Удаление не выполнено: ${e.message}") } }
            finally { mutableUi.update { it.copy(busy = false) }; refresh() }
        }
    }
    override fun onCleared() { pending?.close(); pending = null; super.onCleared() }
}
