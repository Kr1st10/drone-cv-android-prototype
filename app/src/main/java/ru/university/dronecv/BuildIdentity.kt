package ru.university.dronecv

import ru.university.dronecv.timeline.quote

/** Immutable source identity packaged at build time; dirty sources do not identify APK bytes. */
data class BuildIdentity(val gitSha: String?, val gitDirty: Boolean?, val versionName: String?,
                         val versionCode: Int?, val buildType: String?) {
    fun jsonFields(): String = "\"git_sha\":${gitSha?.let(::quote) ?: "null"},\"git_dirty\":$gitDirty," +
        "\"app_version\":${versionName?.let(::quote) ?: "null"},\"version_code\":$versionCode," +
        "\"build_type\":${buildType?.let(::quote) ?: "null"}"

    fun label(): String = "Сборка ${versionName ?: "неизвестно"} (${versionCode ?: "неизвестно"}) · ${buildType ?: "неизвестно"}\n" +
        "Commit: ${gitSha?.take(8) ?: "неизвестно"} · локальные изменения: ${when (gitDirty) { true -> "да"; false -> "нет"; null -> "неизвестно" }}"
}

/** Sole runtime adapter for the existing Gradle Git fields. No Git access on device. */
object PackagedBuild {
    val identity = BuildIdentity(
        BuildConfig.BUILD_GIT_SHA.takeIf { it.matches(Regex("[0-9a-fA-F]{40}")) },
        BuildConfig.BUILD_GIT_DIRTY.takeIf { BuildConfig.BUILD_GIT_STATUS_KNOWN },
        BuildConfig.VERSION_NAME.takeIf { it.isNotBlank() }, BuildConfig.VERSION_CODE,
        BuildConfig.BUILD_TYPE.takeIf { it.isNotBlank() })
    val metadataFields: String = identity.jsonFields() +
        ",\"model_asset\":${quote(BuildConfig.DRONE_MODEL_ASSET)},\"model_sha256\":${quote(BuildConfig.DRONE_MODEL_SHA256)}"
}
