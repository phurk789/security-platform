import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ABIs to package: the SIYI remote is arm64-v8a. Add x86_64 for the emulator: -PedgeAbis=arm64-v8a,x86_64
val edgeAbis = ((project.findProperty("edgeAbis") as String?) ?: "arm64-v8a").split(",").map { it.trim() }

// Release signing from a properties file kept outside the repository (tools/build-apk.sh creates one).
// Without it the APK is signed with the debug key of the machine that builds it.
val signingProps = (System.getenv("EDGE_SIGNING_PROPS") ?: "${System.getProperty("user.home")}/.13store/edge-signing.properties")
    .let { file(it) }
    .takeIf { it.isFile }
    ?.let { f -> Properties().apply { f.inputStream().use { load(it) } } }

// The edge gateway itself: apps/gateway built for Node 18 (`npm run build:android -w @13store/gateway`).
val gatewayBundle = file("../../gateway/dist-android/edge-gateway.mjs")
val gatewayAssets = layout.buildDirectory.dir("generated/gatewayAssets")

android {
    namespace = "com.store13.edge"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.store13.edge"
        minSdk = 26
        targetSdk = 35
        // Raise versionCode for every build given to remotes: Android installs only a higher one, and in-app
        // updates offer only a higher one. -PedgeVersionCode / -PedgeVersionName override it (bench builds).
        // 0.3.0 is versionCode 5: bench test builds 0.2.1-bench / 0.2.2-bench already used 3 and 4.
        versionCode = ((project.findProperty("edgeVersionCode") as String?) ?: "5").toInt()
        versionName = (project.findProperty("edgeVersionName") as String?) ?: "0.3.0"
        ndk { abiFilters += edgeAbis }
    }

    signingConfigs {
        if (signingProps != null) {
            create("field") {
                storeFile = file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("field") ?: signingConfigs.getByName("debug")
        }
    }

    // node, ffmpeg and the launcher are programs, not only libraries: Android must unpack them into the
    // app's native library folder (the only place an app may run programs from).
    packaging { jniLibs { useLegacyPackaging = true } }

    sourceSets["main"].assets.srcDir(gatewayAssets)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    lint { abortOnError = false }
}

val copyGatewayBundle by tasks.registering(Copy::class) {
    doFirst {
        check(gatewayBundle.isFile) { "Missing ${gatewayBundle.path}: run `npm run build:android -w @13store/gateway` in the repository first." }
        for (abi in edgeAbis) {
            val libs = file("src/main/jniLibs/$abi")
            check(file("$libs/libnode.so").isFile && file("$libs/libffmpeg.so").isFile) { "Missing node/ffmpeg for $abi: run tools/build-natives.sh $abi first." }
        }
    }
    from(gatewayBundle)
    into(gatewayAssets.map { it.dir("gateway") })
}
tasks.named("preBuild") { dependsOn(copyGatewayBundle) }

dependencies {
    // QR scanning (Apache 2.0); used only on devices with a camera.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
