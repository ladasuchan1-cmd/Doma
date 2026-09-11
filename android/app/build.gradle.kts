plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Sdílené JS knihovny (detekce, offline analýza, volání Claude, vykreslení) se berou
// z kořene repozitáře (../lib) – Android používá stejný engine jako rozšíření prohlížeče.
val jsLibDir = rootProject.file("../lib")
val generatedAssets = layout.buildDirectory.dir("generated/jslib")
val copyJsLibs by tasks.registering(Copy::class) {
    from(jsLibDir) { include("*.js") }
    into(generatedAssets.map { it.dir("lib") })
}

android {
    namespace = "cz.hlidacpodminek"
    compileSdk = 34

    defaultConfig {
        applicationId = "cz.hlidacpodminek"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(generatedAssets)
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

tasks.named("preBuild") { dependsOn(copyJsLibs) }

// Aplikace záměrně nepoužívá AndroidX – jen framework API (menší APK, jednodušší build).
dependencies {}
