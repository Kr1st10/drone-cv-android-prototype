package ru.university.dronecv.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

@Composable
fun DroneCvTheme(content: @Composable () -> Unit) {
    // Тёмная схема: камера-приложение, видео на чёрном фоне.
    MaterialTheme(colorScheme = darkColorScheme(), content = content)
}
