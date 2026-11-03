package ru.university.dronecv.camera

import android.Manifest
import android.content.pm.PackageManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.FileInputStream
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject

@RunWith(AndroidJUnit4::class)
class CameraInventoryInstrumentedTest {
    @Test fun inventoryIsValidJsonAndIncludesCameraIdentifiers() {
        val inst = InstrumentationRegistry.getInstrumentation()
        val context = inst.targetContext
        assumeTrue(context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY))
        inst.uiAutomation.executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.CAMERA}").use {
            FileInputStream(it.fileDescriptor).use { stream -> stream.readBytes() }
        }
        val report = JSONObject(CameraInventory.collect(context).toString())
        assertEquals(1, report.getInt("schema_version"))
        assertTrue(report.getJSONArray("camera2_ids").length() > 0)
        assertTrue(report.getJSONArray("cameras").length() > 0)
        assertTrue(report.has("camerax"))
    }
}
