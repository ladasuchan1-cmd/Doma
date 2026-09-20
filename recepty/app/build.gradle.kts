plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "cz.doma.recepty"
    compileSdk = 34

    defaultConfig {
        applicationId = "cz.doma.recepty"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
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

// Aplikace záměrně nepoužívá AndroidX ani další knihovny – jen framework API
// (SQLite s FTS, HttpURLConnection, org.json). Menší APK, jednodušší sestavení.
dependencies {}
