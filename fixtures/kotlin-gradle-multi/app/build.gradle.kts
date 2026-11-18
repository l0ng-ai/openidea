plugins {
    kotlin("jvm")
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(project(":lib"))
    implementation("org.apache.commons:commons-lang3:3.17.0")
}

kotlin {
    jvmToolchain(21)
}

application {
    mainClass.set("com.example.app.MainKt")
}
