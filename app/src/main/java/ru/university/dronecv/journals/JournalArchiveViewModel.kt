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

data class ArchiveUi(
    val inventory: JournalInventory? = null,
    val busy: Boolean = false,
    val checkedIds: Set<String> = emptySet(),
    val message: String? = null,
    val error: String? = null,
    val loadError: String? = null,
)

/** Owns selected files across rotation, mode changes and the system picker. */
class JournalArchiveViewModel(private val app: Application) : AndroidViewModel(app) {
    private val store = JournalArchives.get(app)
    val policy: JournalPolicy get() = store.policy
    private var pending: JournalArchive.Export? = null
    private val mutableUi = MutableStateFlow(ArchiveUi())
    val ui = mutableUi.asStateFlow()

    fun refresh() = viewModelScope.launch(Dispatchers.IO) {
        try {
            val inventory = store.inventory()
            val ids = inventory.entries.map { it.id }.toSet()
            mutableUi.update { it.copy(inventory = inventory, checkedIds = it.checkedIds.intersect(ids), loadError = null) }
        } catch (e: Exception) {
            mutableUi.update { it.copy(loadError = "Не удалось прочитать архив: ${e.message}") }
        }
    }
    fun toggle(id: String) {
        mutableUi.update {
            if (it.busy) it
            else it.copy(checkedIds = if (id in it.checkedIds) it.checkedIds - id else it.checkedIds + id)
        }
    }

    fun select(id: String, launchPicker: (String, Boolean) -> Unit) =
        prepareExport(listOf(id), zipped = false, launchPicker)

    fun selectChecked(launchPicker: (String, Boolean) -> Unit) =
        prepareExport(mutableUi.value.checkedIds.toList(), zipped = true, launchPicker)

    private fun prepareExport(ids: List<String>, zipped: Boolean, launchPicker: (String, Boolean) -> Unit) {
        if (mutableUi.value.busy) return
        mutableUi.update { it.copy(busy = true, message = null, error = null) }
        viewModelScope.launch(Dispatchers.IO) {
            var selected: JournalArchive.Export? = null
            try {
                val lease = if (zipped) store.selectZip(ids) else store.selectExport(ids.single())
                selected = lease
                val filename = lease.suggestedName
                withContext(Dispatchers.Main.immediate) {
                    pending = lease
                    launchPicker(filename, zipped)
                    selected = null // Ownership is now in pending, until the picker callback.
                }
            } catch (e: Exception) {
                withContext(NonCancellable + Dispatchers.Main.immediate) {
                    pending?.close(); pending = null
                    mutableUi.update { it.copy(busy = false, error = "Не удалось подготовить экспорт: ${e.message}") }
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
                mutableUi.update {
                    it.copy(message = if (selected.zipped) "ZIP с журналами экспортирован" else "Журнал экспортирован", error = null)
                }
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
    fun rename(id: String, title: String) =
        updateArchive("Название сохранено", "Переименование не выполнено") { store.rename(id, title) }

    fun delete(id: String, confirmed: Boolean) =
        updateArchive("Журнал удалён", "Удаление не выполнено") { store.delete(id, allowUnexported = confirmed) }

    private fun updateArchive(success: String, failure: String, action: () -> Unit) {
        if (mutableUi.value.busy) return
        mutableUi.update { it.copy(busy = true, message = null, error = null) }
        viewModelScope.launch(Dispatchers.IO) {
            try {
                action()
                mutableUi.update { it.copy(message = success) }
            } catch (e: Exception) {
                mutableUi.update { it.copy(error = "$failure: ${e.message}") }
            } finally { mutableUi.update { it.copy(busy = false) }; refresh() }
        }
    }
    override fun onCleared() { pending?.close(); pending = null; super.onCleared() }
}
