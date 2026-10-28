package com.store13.edge

import android.content.pm.PackageInstaller
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdatesTest {
    private val sha = "ab".repeat(32)

    @Test
    fun readsTheServersLatestRelease() {
        // GET /api/v1/edge/app/latest (EdgeAppRelease in packages/shared, publishedBy left out)
        val r = AppRelease.parse("""{"packageName":"com.store13.edge","versionCode":3,"versionName":"0.3.0","sha256":"${sha.uppercase()}","size":21000000,"publishedAt":1}""")
        assertEquals(AppRelease(3, "0.3.0", sha, 21_000_000), r)
        assertNull(AppRelease.parse("""{"versionCode":3,"versionName":"0.3.0","sha256":"short","size":1}"""))
        assertNull(AppRelease.parse("""{"versionCode":0,"versionName":"x","sha256":"$sha","size":1}"""))
        assertNull(AppRelease.parse("not json"))
    }

    @Test
    fun offersOnlyAHigherVersionCode() {
        val r = AppRelease(3, "0.3.0", sha, 1)
        assertTrue(UpdateLogic.isNewer(2, r))
        assertFalse(UpdateLogic.isNewer(3, r))
        assertFalse(UpdateLogic.isNewer(4, r))
    }

    @Test
    fun comparesSigningCertificates() {
        val ours = listOf(byteArrayOf(1, 2, 3))
        assertEquals(true, UpdateLogic.sameSigner(ours, listOf(byteArrayOf(9), byteArrayOf(1, 2, 3))))
        assertEquals(false, UpdateLogic.sameSigner(ours, listOf(byteArrayOf(4, 5, 6))))
        assertNull("unreadable certificates: let Android decide", UpdateLogic.sameSigner(ours, emptyList()))
        assertEquals("0aff", UpdateLogic.hex(byteArrayOf(10, -1)))
    }

    @Test
    fun explainsWhatTheInstallerAnswered() {
        assertEquals(UpdateLogic.Outcome.DONE, UpdateLogic.outcome(PackageInstaller.STATUS_SUCCESS))
        assertEquals(UpdateLogic.Outcome.NEEDS_CONFIRM, UpdateLogic.outcome(PackageInstaller.STATUS_PENDING_USER_ACTION))
        assertEquals(UpdateLogic.Outcome.CANCELLED, UpdateLogic.outcome(PackageInstaller.STATUS_FAILURE_ABORTED))
        assertEquals(UpdateLogic.Outcome.WRONG_SIGNER, UpdateLogic.outcome(PackageInstaller.STATUS_FAILURE_CONFLICT))
        assertEquals(UpdateLogic.Outcome.NO_SPACE, UpdateLogic.outcome(PackageInstaller.STATUS_FAILURE_STORAGE))
        assertEquals(UpdateLogic.Outcome.OTHER, UpdateLogic.outcome(PackageInstaller.STATUS_FAILURE))
    }
}
