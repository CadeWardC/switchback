import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
    // the real trail file the tests read when it is there (see PackFileTest)
    System.getenv("SWITCHBACK_TEST_DATA")?.let { systemProperty("switchback.testData", it) }
    testLogging {
        events("passed", "skipped", "failed")
        showStandardStreams = true
    }
}
