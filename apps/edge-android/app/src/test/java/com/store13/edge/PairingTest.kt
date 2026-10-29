package com.store13.edge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingTest {
    @Test
    fun readsTheQrFromTheWebConsole() {
        // Same text as pairingLink() in packages/shared/src/protocol.ts
        val p = PairingLink.parse("psedge://pair?server=http%3A%2F%2F192.168.20.13%3A8090&code=042917")
        assertEquals(PairingLink.Parsed("http://192.168.20.13:8090", "042917"), p)
    }

    @Test
    fun acceptsTypedDigitsWithSpacesOrDashes() {
        assertEquals(PairingLink.Parsed(null, "042917"), PairingLink.parse(" 042 917 "))
        assertEquals(PairingLink.Parsed(null, "042917"), PairingLink.parse("042-917"))
    }

    @Test
    fun refusesAnythingElse() {
        for (bad in listOf("04291", "abcdef", "psedge://pair?code=12", "psedge://pair?server=javascript%3Aalert(1)&code=123456", "https://x/pair?code=123456"))
            assertNull(bad, PairingLink.parse(bad))
    }

    @Test
    fun normalisesTheServerAddress() {
        assertEquals("http://192.168.20.13:8090", ServerAddress.normalize("192.168.20.13:8090"))
        assertEquals("http://192.168.20.13:8090", ServerAddress.normalize(" http://192.168.20.13:8090/ "))
        assertEquals("https://edge.example.com", ServerAddress.normalize("https://edge.example.com"))
        assertNull(ServerAddress.normalize("ftp://x"))
        assertNull(ServerAddress.normalize("http://x/api"))
        assertNull(ServerAddress.normalize(""))
        assertEquals("ws://192.168.20.13:8090", ServerAddress.toWs("http://192.168.20.13:8090"))
        assertEquals("wss://edge.example.com", ServerAddress.toWs("https://edge.example.com"))
    }

    @Test
    fun relaysUniGcsOnTheFirstVehicleUnlessThePairingDecides() {
        fun pairing(devices: String) = Pairing("http://x:1", "edge-1", "Site", org.json.JSONObject("{}"), org.json.JSONArray(devices), 0)
        val two = pairing("""[{"type":"siyi-camera","deviceId":"CAM-1"},{"type":"mavlink","deviceId":"UGV-01"},{"type":"mavlink","deviceId":"UGV-02"}]""").gatewayDevices()
        assertFalse(two.getJSONObject(0).has("gcsRelay"))
        assertEquals(true, two.getJSONObject(1).get("gcsRelay"))
        assertFalse("one relay per remote (one port)", two.getJSONObject(2).has("gcsRelay"))
        val off = pairing("""[{"type":"mavlink","deviceId":"UGV-01","gcsRelay":false}]""").gatewayDevices()
        assertEquals(false, off.getJSONObject(0).get("gcsRelay"))
        val elsewhere = pairing("""[{"type":"mavlink","deviceId":"UGV-01"},{"type":"mavlink","deviceId":"UGV-02","gcsRelay":{"port":19860}}]""").gatewayDevices()
        assertFalse(elsewhere.getJSONObject(0).has("gcsRelay"))
    }

    @Test
    fun parsesTheGatewayStatusFile() {
        // Shape of GatewayStatus in apps/gateway/src/gateway.ts
        val s = GatewayStatus.parse(
            """{"at":10000,"gatewayId":"edge-unirc-01","server":{"url":"ws://192.168.20.13:8090","connected":true,"refused":false,"since":1000},
               "devices":[{"deviceId":"UGV-01","kind":"ugv","accepted":true,"lastTelemetryAt":9400,"video":{"status":"pushing","detail":"Pushing h264","codec":"h264"},
                           "relay":{"listen":"127.0.0.1:19857","connected":true,"sysid":255,"lastSeenAt":9900}},
                          {"deviceId":"CAM-02","kind":"cctv","accepted":false,"rejected":"Device is not registered"}],
               "dropped":{"telemetry":0,"cmd":0,"event":0,"camera_result":0}}""",
        )!!
        assertTrue(s.serverConnected)
        assertFalse(s.keyRefused)
        assertEquals(0.6, s.devices[0].ageSeconds(s.at)!!, 1e-9)
        assertEquals("h264", s.devices[0].video!!.codec)
        assertEquals("Device is not registered", s.devices[1].rejected)
        assertNull(s.devices[1].lastTelemetryAt)
        assertEquals(GatewayStatus.Relay("127.0.0.1:19857", true), s.devices[0].relay)
        assertNull(s.devices[1].relay)
        assertNull(GatewayStatus.parse("{"))
    }
}
