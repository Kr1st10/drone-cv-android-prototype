package ru.university.dronecv.camera

import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class CameraFramePoolTest {
    @Test fun threeLeasesBoundStorageAndOnlyReleasedBufferCanBeReused() {
        val pool = CameraFramePool(48)
        val a = pool.acquire(2, 2)!!; val b = pool.acquire(2, 2)!!; val c = pool.acquire(2, 2)!!
        a.pixels.fill(11); b.pixels.fill(22); c.pixels.fill(33)
        assertNull(pool.acquire(2, 2)); assertEquals(48L, pool.allocatedBytes)
        b.close(); val next = pool.acquire(2, 2)!!; assertSame(b.pixels, next.pixels)
        b.close(); assertNull(pool.acquire(2, 2)) // an old lease cannot release a newly reused slot.
        next.pixels.fill(44); assertTrue(a.pixels.all { it == 11 }); assertTrue(c.pixels.all { it == 33 })
        a.close(); c.close(); next.close()
    }

    @Test fun cropResizeHonorsByteBudgetIncludingLeasedBuffers() {
        val pool = CameraFramePool(32); val old = pool.acquire(2, 2)!!
        assertNull(pool.acquire(3, 2)); assertNull(pool.acquire(Int.MAX_VALUE, Int.MAX_VALUE))
        old.pixels.fill(9); val second = pool.acquire(1, 2)!!
        assertEquals(24L, pool.allocatedBytes); second.close()
        val resized = pool.acquire(2, 2)!!
        assertEquals(32L, pool.allocatedBytes); assertTrue(old.pixels.all { it == 9 })
        old.close(); resized.close()
        assertThrows(IllegalArgumentException::class.java) { pool.acquire(0, 2) }
    }

    @Test fun copyIntoOwnedPixelsSurvivesSourceMutationAndNextConverterCall() {
        val pool = CameraFramePool(); val converter = RgbaFrameConverter()
        val lease = pool.acquire(2, 1)!!
        val rgba = ByteBuffer.wrap(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8))
        val owned = converter.copyInto(rgba, 2, 1, 8, 4, 0, 0, 2, 1, lease.pixels)
        val expected = owned.pixels.copyOf()
        rgba.put(0, 100.toByte()); converter.convert(rgba, 2, 1, 8, 4, 0, 0, 2, 1)
        converter.clear(); assertArrayEquals(expected, owned.pixels)
        assertThrows(IllegalArgumentException::class.java) {
            converter.copyInto(rgba, 2, 1, 8, 4, 0, 0, 2, 1, IntArray(1))
        }
        lease.close()
    }
}
