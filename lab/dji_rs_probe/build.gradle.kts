plugins {
    application
    alias(libs.plugins.kotlin.jvm)
}

dependencies {
    implementation(libs.jserialcomm)
    testImplementation(libs.junit)
}

kotlin {
    jvmToolchain(17)
    sourceSets.named("main") { kotlin.srcDir("src/shared/kotlin") }
}

application { mainClass.set("ru.university.dronecv.weact.MainKt") }

tasks.test { testLogging { events("passed", "skipped", "failed") } }
