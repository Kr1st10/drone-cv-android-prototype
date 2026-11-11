package ru.university.dronecv.motion

import org.junit.Assert.*
import org.junit.Test
import ru.university.dronecv.camera.CaptureTimebase
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox

class MotionJournalTest {
    @Test fun sessionsRejectLateCallbacksAndKeepOriginalFrame() {
        var now = 1000L
        val journal = MotionJournal({ now })
        journal.start()
        val first = journal.token()!!
        val id = journal.frame(first, FrameStamp(990, CaptureTimebase.ELAPSED_REALTIME, 1010), 640, 480,
            MotionMarker("1234abcd", 7), "data:image/jpeg;base64,AA==")!!
        now = 1020
        val detection = Detection("drone", .8f, NormalizedBox(.1f, .2f, .3f, .4f))
        journal.detection(first, id, detection, now)
        journal.stop()
        journal.start()
        journal.detection(first, id, detection, now)
        now = 1030
        journal.stop()
        val report = journal.ui.value.report!!
        assertTrue(report.contains("\"detections\":[]"))
        assertTrue(report.contains("\"complete\":true"))
    }

    @Test fun abortReasonEscapesJsonControlCharacters() {
        val journal = MotionJournal({ 100L })
        journal.start()
        journal.stop("quote \" slash \\ tab\t return\r null\u0000")
        val report = journal.ui.value.report!!
        assertTrue(report.contains("\"abort_reason\":\"quote \\\" slash \\\\ tab\\u0009 return\\u000d null\\u0000\""))
        assertFalse(report.any { it.code < 0x20 })
    }

    @Test fun geometryChangeAbortsAndBoundsAreReported() {
        var now = 100L
        val journal = MotionJournal({ now }, limit = 1)
        journal.start()
        val token = journal.token()!!
        journal.frame(token, FrameStamp(null, CaptureTimebase.UNKNOWN, 110), 2, 3, null, null)
        journal.frame(token, FrameStamp(null, CaptureTimebase.UNKNOWN, 120), 2, 3, null, null)
        now = 130
        journal.stop()
        assertTrue(journal.ui.value.report!!.contains("\"truncated\":true"))
        journal.start()
        val next = journal.token()!!
        journal.frame(next, FrameStamp(null, CaptureTimebase.UNKNOWN, 140), 2, 3, null, null)
        journal.frame(next, FrameStamp(null, CaptureTimebase.UNKNOWN, 150), 3, 2, null, null)
        assertFalse(journal.ui.value.recording)
        assertTrue(journal.ui.value.report!!.contains("\"abort_reason\":\"Geometry changed\""))
    }
}
