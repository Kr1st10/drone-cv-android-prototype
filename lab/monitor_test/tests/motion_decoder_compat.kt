package ru.university.dronecv.motion

import ru.university.dronecv.detection.yolo.ArgbImage
import ru.university.dronecv.detection.yolo.rotated
import java.io.File
import javax.imageio.ImageIO

private fun synthetic(module: Int, twice: Boolean = false, width: Int = 240, height: Int = 180): ArgbImage {
    val pixels = IntArray(width * height) { -1 }
    fun rect(x: Int, y: Int, w: Int, h: Int, color: Int) {
        for (yy in y until y+h) for (xx in x until x+w) if (xx in 0 until width && yy in 0 until height) pixels[yy*width+xx]=color
    }
    val bytes = intArrayOf(0xd1, 0x12, 0x34, 0x56, 0x78, 0, 0, 0, 42, 0)
    var crc=0
    for (byte in bytes.take(9)) { crc=crc xor byte;repeat(8) { crc=((crc shl 1) xor if(crc and 128 != 0) 7 else 0) and 255 } }
    bytes[9]=crc
    for(x in if(twice) listOf(10,120) else listOf(10)) {
        val y=10
        rect(x,y,14*module,12*module,0xff000000.toInt())
        rect(x+module,y+module,12*module,10*module,-1)
        for(bit in 0 until 80) if(bytes[bit/8] and (1 shl (7-bit%8)) != 0) {
            rect(x+(2+bit%10)*module,y+(2+bit/10)*module,module,module,0xff000000.toInt())
        }
    }
    return ArgbImage(width,height,pixels)
}

/** JVM integration check of the production Android-independent decoder. */
fun main(args: Array<String>) {
    require(args.size == 3) { "PNG expected_run_id expected_step_id" }
    val bitmap = requireNotNull(ImageIO.read(File(args[0]))) { "Unreadable fixture image" }
    val image = ArgbImage(bitmap.width, bitmap.height, bitmap.getRGB(0, 0, bitmap.width, bitmap.height, null, 0, bitmap.width))
    val expected = if (args[1] == "none") null else MotionMarker(args[1], args[2].toLong())
    for (rotation in listOf(0, 90, 180, 270)) {
        val sensor = image.rotated((360 - rotation) % 360)
        val actual = MotionMarkerDecoder.decode(sensor, rotation)
        check(actual == expected) { "rotation=$rotation: $actual != $expected" }
    }
    val oversized = ArgbImage(1025, 1024, IntArray(1025 * 1024) { -1 })
    check(MotionMarkerDecoder.decode(oversized, 0) == null)
    check(MotionMarkerDecoder.decode(synthetic(2),0)==MotionMarker("12345678",42)) { "24x20 software minimum rejected" }
    check(MotionMarkerDecoder.decode(synthetic(1),0)==null) { "12x10 below-minimum candidate accepted" }
    check(MotionMarkerDecoder.decode(synthetic(6,width=90,height=80),0)==null) { "candidate over 3/4 accepted" }
    check(MotionMarkerDecoder.decode(synthetic(2,twice=true),0)==null) { "duplicate valid sync must be ambiguous" }
    println("production MotionMarkerDecoder: rotations 0/90/180/270, candidate minimum/maximum, duplicates and MAX_PIXELS passed (${bitmap.width}x${bitmap.height}; expected=$expected)")
}
