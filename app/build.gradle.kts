import groovy.json.JsonSlurper
import java.security.MessageDigest

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Единственный источник истины о модели — ml/model_manifest.json (путь в assets и ожидаемый SHA-256 ONNX).
@Suppress("UNCHECKED_CAST")
val droneModel = (JsonSlurper().parse(rootProject.file("ml/model_manifest.json")) as Map<String, Any>)["android"]
    as Map<String, String>
val droneModelAsset: String = droneModel.getValue("asset_path")
val droneModelSha256: String = droneModel.getValue("onnx_sha256")

android {
    namespace = "ru.university.dronecv"
    compileSdk = 35

    defaultConfig {
        applicationId = "ru.university.dronecv"
        minSdk = 26
        targetSdk = 35
        versionCode = 4
        versionName = "0.4.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "DRONE_MODEL_ASSET", "\"$droneModelAsset\"")
        buildConfigField("String", "DRONE_MODEL_SHA256", "\"$droneModelSha256\"")

        ndk {
            // Целевое устройство — arm64; x86_64 — для эмулятора. armeabi-v7a/x86 исключены ради размера APK.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    androidResources {
        // Модель не сжимается в APK: быстрее копируется при первом запуске.
        noCompress += "onnx"
    }
    testOptions {
        unitTests.all {
            it.systemProperty("drone.model.path", rootProject.file("ml/weights/yolo11s-drone-640.onnx").absolutePath)
            it.systemProperty("drone.model.sha256", droneModelSha256)
            it.systemProperty("drone.parity.dir", rootProject.file("ml/data/android_parity").absolutePath)
            it.maxHeapSize = "2g"
            it.testLogging { events("passed", "skipped", "failed"); showStandardStreams = true }
        }
    }
}

// JVM-тесты выполняют тот же Kotlin-код через onnxruntime (desktop); Android-артефакт с JNI для Android
// в JVM загрузить нельзя, поэтому он исключается из classpath unit-тестов.
configurations.matching { it.name.endsWith("UnitTestRuntimeClasspath") }.configureEach {
    exclude(group = "com.microsoft.onnxruntime", module = "onnxruntime-android")
}

/** Не допускает APK без модели или с неверным SHA-256. */
val verifyDroneModel by tasks.registering {
    val modelFile = file("src/main/assets/$droneModelAsset")
    val expected = droneModelSha256
    inputs.property("expectedSha256", expected)
    doLast {
        if (!modelFile.isFile) {
            throw GradleException(
                "Model missing: $modelFile. Run: python ml/scripts/fetch_and_export.py && " +
                    "python ml/scripts/install_android_model.py"
            )
        } else {
            val md = MessageDigest.getInstance("SHA-256")
            modelFile.inputStream().use { input ->
                val buf = ByteArray(1 shl 16)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            val actual = md.digest().joinToString("") { "%02x".format(it) }
            if (actual != expected) {
                throw GradleException("Model SHA-256 mismatch for $modelFile: expected $expected, got $actual")
            }
            logger.lifecycle("Drone model OK: $modelFile (sha256 $actual)")
        }
    }
}
tasks.named("preBuild") { dependsOn(verifyDroneModel) }

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.exifinterface)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    debugImplementation(libs.androidx.compose.ui.tooling)

    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)

    implementation(libs.onnxruntime.android)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.onnxruntime.jvm)

    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
}
