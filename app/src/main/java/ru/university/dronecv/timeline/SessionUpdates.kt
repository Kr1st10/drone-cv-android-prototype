package ru.university.dronecv.timeline

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** The transform can be retried; callbacks must not acquire producer locks. */
internal fun <T, S> MutableStateFlow<T>.updateForSession(
    session: S,
    sessionOf: (T) -> S,
    transform: (T) -> T,
) = update { current -> if (sessionOf(current) == session) transform(current) else current }
