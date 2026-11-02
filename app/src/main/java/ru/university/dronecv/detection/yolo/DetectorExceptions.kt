package ru.university.dronecv.detection.yolo

/** Базовая ошибка детектора: модель не найдена, повреждена, имеет неожиданный формат или инференс упал. */
open class DetectorException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** Файл модели отсутствует (например, не выполнен `ml/scripts/install_android_model.py`). */
class ModelNotFoundException(message: String, cause: Throwable? = null) : DetectorException(message, cause)

/** SHA-256 модели не совпал с ожидаемым. */
class ModelIntegrityException(message: String) : DetectorException(message)

/** Структура модели (тензоры, классы) не соответствует ожидаемой. */
class ModelFormatException(message: String, cause: Throwable? = null) : DetectorException(message, cause)

/** Ошибка ONNX Runtime при создании сессии или выполнении инференса. */
class InferenceException(message: String, cause: Throwable? = null) : DetectorException(message, cause)
