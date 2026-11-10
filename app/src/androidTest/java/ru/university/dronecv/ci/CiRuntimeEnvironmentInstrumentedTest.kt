package ru.university.dronecv.ci

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** A system property can change after zygote starts; verify the target process's actual ART limit. */
@RunWith(AndroidJUnit4::class)
class CiRuntimeEnvironmentInstrumentedTest {
    @Test fun targetProcessUsesConfiguredHeap() {
        val maximum = Runtime.getRuntime().maxMemory()
        Log.i("CiRuntimeEnvironment", "Runtime.maxMemory=$maximum bytes")
        assertTrue("ART heap must be positive", maximum > 0)
        InstrumentationRegistry.getArguments().getString("ciExpectedMaxHeapMiB")?.let { expected ->
            assertEquals("Restarted CI zygote must use the configured normal-app heap",
                expected.toLong() * 1024 * 1024, maximum)
        }
    }
}
