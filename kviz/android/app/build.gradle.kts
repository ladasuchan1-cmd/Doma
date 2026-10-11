plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Kvízy (HTML + pozadí) se berou z ../../web – aplikace je ukazuje beze změny,
// mobilní úpravy přidává až za běhu (assets/app/mobile.css a bridge.js).
val quizDir = rootProject.file("../web")
val generatedAssets = layout.buildDirectory.dir("generated/kviz")
val copyQuizzes by tasks.registering(Copy::class) {
    from(quizDir) { include("*.html", "pozadi/**") }
    into(generatedAssets.map { it.dir("kviz") })
}

android {
    namespace = "cz.boubinkviz"
    compileSdk = 34

    defaultConfig {
        applicationId = "cz.boubinkviz"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    // Pevný ladicí klíč v repozitáři: každé sestavení (lokálně i na GitHubu) má stejný podpis,
    // takže nová verze se nainstaluje přes starou a nahrané ukázky zůstanou.
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(generatedAssets)
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
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

tasks.named("preBuild") { dependsOn(copyQuizzes) }

// Bez AndroidX – jen framework API. Testy párování názvů běží na JVM (org.json místo stubů z android.jar).
dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
