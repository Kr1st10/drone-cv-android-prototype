package ru.university.dronecv.camera

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import ru.university.dronecv.R

/** Главный экран: запрос разрешения, видеопревью и обработка ошибок камеры. */
@Composable
fun CameraScreen() {
    val context = LocalContext.current
    val hasCameraHardware = remember {
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }

    var hasPermission by remember { mutableStateOf(context.isCameraPermissionGranted()) }
    var permanentlyDenied by rememberSaveable { mutableStateOf(false) }
    var requestedOnce by rememberSaveable { mutableStateOf(false) }
    var cameraError by remember { mutableStateOf<Throwable?>(null) }
    var recoverableIssue by remember { mutableStateOf<Int?>(null) }
    var bindAttempt by remember { mutableIntStateOf(0) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasPermission = granted
        // Если после отказа система больше не показывает rationale — диалог заблокирован,
        // остаётся только переход в настройки.
        permanentlyDenied = !granted && context.findActivity()?.let {
            !ActivityCompat.shouldShowRequestPermissionRationale(it, Manifest.permission.CAMERA)
        } == true
    }

    // Разрешение могли выдать/отозвать в настройках, пока приложение было в фоне.
    LifecycleResumeEffect(Unit) {
        val granted = context.isCameraPermissionGranted()
        if (granted != hasPermission) {
            hasPermission = granted
            if (granted) permanentlyDenied = false
        }
        onPauseOrDispose { }
    }

    LaunchedEffect(Unit) {
        if (!hasPermission && !requestedOnce) {
            requestedOnce = true
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = Color.Black) {
        when {
            !hasCameraHardware -> MessageContent(
                title = stringResource(R.string.camera_error_title),
                message = stringResource(R.string.camera_not_available),
            )

            !hasPermission -> PermissionContent(
                permanentlyDenied = permanentlyDenied,
                onRequest = { permissionLauncher.launch(Manifest.permission.CAMERA) },
                onOpenSettings = { context.openAppSettings() },
            )

            cameraError != null -> MessageContent(
                title = stringResource(R.string.camera_error_title),
                message = cameraError.toUserMessage(context),
                actionLabel = stringResource(R.string.retry),
                onAction = {
                    cameraError = null
                    recoverableIssue = null
                    bindAttempt++
                },
            )

            else -> Box(modifier = Modifier.fillMaxSize()) {
                // key() пересоздаёт привязку камеры при нажатии «Повторить».
                key(bindAttempt) {
                    CameraPreview(
                        modifier = Modifier.fillMaxSize(),
                        onError = { cameraError = it },
                        onRecoverableIssue = { recoverableIssue = it },
                    )
                }
                recoverableIssue?.let { code ->
                    Text(
                        text = recoverableIssueText(code),
                        color = Color.White,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier
                            .align(Alignment.TopCenter)
                            .safeDrawingPadding()
                            .padding(16.dp)
                            .background(Color(0x99000000))
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun PermissionContent(
    permanentlyDenied: Boolean,
    onRequest: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    if (permanentlyDenied) {
        MessageContent(
            title = stringResource(R.string.permission_title),
            message = stringResource(R.string.permission_denied_permanently),
            actionLabel = stringResource(R.string.open_settings),
            onAction = onOpenSettings,
        )
    } else {
        MessageContent(
            title = stringResource(R.string.permission_title),
            message = stringResource(R.string.permission_rationale),
            actionLabel = stringResource(R.string.grant_permission),
            onAction = onRequest,
        )
    }
}

@Composable
private fun MessageContent(
    title: String,
    message: String,
    actionLabel: String? = null,
    onAction: () -> Unit = {},
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(title, style = MaterialTheme.typography.titleLarge, color = Color.White)
        Spacer(Modifier.height(12.dp))
        Text(
            message,
            style = MaterialTheme.typography.bodyMedium,
            color = Color.White,
            textAlign = TextAlign.Center,
        )
        if (actionLabel != null) {
            Spacer(Modifier.height(24.dp))
            Button(onClick = onAction) { Text(actionLabel) }
        }
    }
}

private fun recoverableIssueText(code: Int): String = when (code) {
    CameraState.ERROR_CAMERA_IN_USE,
    CameraState.ERROR_MAX_CAMERAS_IN_USE -> "Камера занята другим приложением…"
    else -> "Переподключение к камере…"
}

private fun Throwable?.toUserMessage(context: Context): String = when (this) {
    is CameraUnavailableException -> context.getString(R.string.camera_not_available)
    is CameraStateException -> when (code) {
        CameraState.ERROR_CAMERA_DISABLED -> "Камера отключена политикой устройства."
        CameraState.ERROR_DO_NOT_DISTURB_MODE_ENABLED -> "Камера недоступна в режиме «Не беспокоить»."
        else -> "Не удалось открыть камеру (код $code)."
    }
    null -> ""
    else -> localizedMessage ?: "Не удалось запустить камеру."
}

private fun Context.isCameraPermissionGranted(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED

private fun Context.openAppSettings() {
    startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
