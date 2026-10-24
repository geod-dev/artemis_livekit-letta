package ai.artemis.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ArtemisSiteTest {
    @Test public void effectivePortUsesTheSchemeDefault() {
        assertEquals(443, ArtemisSite.effectivePort("https", -1));
        assertEquals(80, ArtemisSite.effectivePort("http", -1));
        assertEquals(8443, ArtemisSite.effectivePort("https", 8443));
    }

    @Test public void originLeavesOutTheDefaultPort() {
        assertEquals("https://artemis.example.com",
            ArtemisSite.originOf("artemis.example.com", 443));
        assertEquals("https://artemis.example.com:8443",
            ArtemisSite.originOf("artemis.example.com", 8443));
    }

    @Test public void sameSiteMatchesHostWithoutCaseAndTheEffectivePort() {
        assertTrue(ArtemisSite.isSameSite("artemis.example.com", 443, "https",
            "ARTEMIS.example.com", -1));
        assertTrue(ArtemisSite.isSameSite("artemis.example.com", 443, "https",
            "artemis.example.com", 443));
    }

    @Test public void sameSiteRejectsOtherHostsPortsAndSchemes() {
        assertFalse(ArtemisSite.isSameSite("artemis.example.com", 443, "https",
            "evil.example.com", -1));
        assertFalse(ArtemisSite.isSameSite("artemis.example.com", 443, "https",
            "artemis.example.com", 8443));
        assertFalse(ArtemisSite.isSameSite("artemis.example.com", 443, "http",
            "artemis.example.com", -1));
        assertFalse(ArtemisSite.isSameSite(null, 443, "https", "artemis.example.com", -1));
    }

    @Test public void nonDefaultHomePortMustMatchExactly() {
        assertTrue(ArtemisSite.isSameSite("artemis.example.com", 8443, "https",
            "artemis.example.com", 8443));
        assertFalse(ArtemisSite.isSameSite("artemis.example.com", 8443, "https",
            "artemis.example.com", -1));
    }
}
