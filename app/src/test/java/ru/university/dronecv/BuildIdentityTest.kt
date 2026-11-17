package ru.university.dronecv

import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.diagnostics.DiagnosticFrames

class BuildIdentityTest {
    @Test fun runtimeUsesExistingPackagedGitFields() {
        assertEquals(BuildConfig.BUILD_GIT_SHA.takeUnless { it == "unknown" }, PackagedBuild.identity.gitSha)
        assertEquals(BuildConfig.BUILD_GIT_DIRTY.takeIf { BuildConfig.BUILD_GIT_STATUS_KNOWN }, PackagedBuild.identity.gitDirty)
        assertEquals(BuildConfig.VERSION_CODE, PackagedBuild.identity.versionCode)
        assertEquals(BuildConfig.BUILD_TYPE, PackagedBuild.identity.buildType)
    }

    @Test fun fullCommitAndDirtyAreExportedAndLabelIsShort() {
        val sha = "1234567890abcdef".repeat(2) + "12345678"
        val build = BuildIdentity(sha, true, "0.5.2", 7, "debug")
        assertTrue(build.jsonFields().contains("\"git_sha\":\"$sha\""))
        assertTrue(build.jsonFields().contains("\"git_dirty\":true"))
        assertTrue(build.label().contains("12345678"))
        assertFalse(build.label().contains(sha))
        assertTrue(build.label().contains("локальные изменения: да"))
    }

    @Test fun unknownIsNullRatherThanCleanOrCurrentBuild() {
        val unknown = BuildIdentity(null, null, null, null, null)
        assertEquals("\"git_sha\":null,\"git_dirty\":null,\"app_version\":null,\"version_code\":null,\"build_type\":null", unknown.jsonFields())
        assertTrue(unknown.label().contains("неизвестно"))
    }

    @Test fun metadataBelongsToSessionAndLateOldMetadataIsRejected() {
        val frames = DiagnosticFrames()
        val first = frames.start(1)
        frames.event(first, "metadata", "{\"confidence\":0.5}", 2)
        val saved = frames.stop(first, 3, false, null)!!
        val second = frames.start(4)
        frames.event(first, "metadata", "{\"confidence\":0.8}", 5)
        assertNull(frames.stop(second, 6, false, null)!!.sessionMetadata)
        assertEquals("{\"confidence\":0.5}", saved.sessionMetadata)
    }
}
