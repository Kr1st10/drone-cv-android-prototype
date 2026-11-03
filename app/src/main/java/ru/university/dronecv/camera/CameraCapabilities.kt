package ru.university.dronecv.camera

/** A request is not evidence that the camera switched optical sensors. */
internal data class ZoomRange(val min: Float, val max: Float) {
    init { require(min.isFinite() && max.isFinite() && min > 0 && max >= min) }
    fun permits(value: Float) = value.isFinite() && value >= min && value <= max
}

internal sealed interface ZoomDecision {
    data class Request(val ratio: Float) : ZoomDecision
    data class Unavailable(val reason: String) : ZoomDecision
}

internal fun zoomRequest(value: Float, range: ZoomRange?): ZoomDecision = when {
    range == null -> ZoomDecision.Unavailable("Диапазон зума пока недоступен")
    !range.permits(value) -> ZoomDecision.Unavailable("Приближение ${value}× недоступно (диапазон ${range.min}–${range.max}×)")
    else -> ZoomDecision.Request(value)
}

/** Physical ID metadata can be absent even when the device uses a physical camera. */
internal fun sensorEvidence(activeId: String?, physicalIds: Set<String>): String = when {
    activeId == null -> "Активный физический ID недоступен; объектив не подтверждён"
    activeId !in physicalIds -> "Активный физический ID: $activeId (не найден в списке физических ID)"
    else -> "Активный физический ID: $activeId (доступно подтверждение смены сенсора сравнением с 1×)"
}
