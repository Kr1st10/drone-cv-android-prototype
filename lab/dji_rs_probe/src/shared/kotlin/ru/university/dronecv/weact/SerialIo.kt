package ru.university.dronecv.weact

/** The caller owns the port. Null means a read deadline expired; disconnect is an IOException. */
internal interface SerialIo : AutoCloseable {
    fun read(timeoutNs: Long): ByteArray?
    fun write(bytes: ByteArray, timeoutNs: Long)
}
