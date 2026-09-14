// sub2sub-tailcat carries TLS bytes for one fixed service. Business authentication stays in Node.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
	"tailscale.com/wgengine/filter"
)

const servicePort = 443

type identity struct {
	RegionID tailcfg.DERPRegionID `json:"regionId,omitempty"`
	Key      key.NodePrivate      `json:"key"`
	PSK      tailcat.PresharedKey `json:"psk"`
	Region   *tailcfg.DERPRegion  `json:"region,omitempty"`
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 3 || (os.Args[1] == "serve" && len(os.Args) != 4) || (os.Args[1] == "dial" && len(os.Args) != 3) {
		return fmt.Errorf("expected serve <identity-file> <loopback-port> or dial <tailcat-address>")
	}
	// EOF from our owner closes all transports, including after an unexpected Node exit.
	go func() { io.Copy(io.Discard, os.Stdin); os.Exit(0) }()
	// Upstream debug logs contain network metadata; operation errors are reported by main.
	logf := func(string, ...any) {}
	switch os.Args[1] {
	case "serve":
		port, err := strconv.Atoi(os.Args[3])
		if err != nil || port < 1 || port > 65535 {
			return fmt.Errorf("invalid loopback service port")
		}
		var id identity
		data, err := os.ReadFile(os.Args[2])
		if os.IsNotExist(err) {
			id = identity{Key: key.NewNode(), PSK: tailcat.NewPresharedKey()}
			data, err = json.Marshal(id)
			if err != nil {
				return err
			}
			if err = os.MkdirAll(filepath.Dir(os.Args[2]), 0700); err != nil {
				return err
			}
			f, err := os.OpenFile(os.Args[2], os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				return err
			}
			_, err = f.Write(data)
			closeErr := f.Close()
			if err != nil {
				return err
			}
			if closeErr != nil {
				return closeErr
			}
		} else if err != nil {
			return err
		} else if err = json.Unmarshal(data, &id); err != nil {
			return err
		}
		if id.Key.IsZero() || id.PSK.IsZero() {
			return fmt.Errorf("invalid saved Tailcat identity")
		}
		server := &tailcat.Server{Key: id.Key, PresharedKey: id.PSK, Logf: logf, Region: id.Region, RegionID: id.RegionID, ServedTCPPorts: []filter.PortRange{{First: servicePort, Last: servicePort}}}
		server.OnTCP = func(p uint16) func(net.Conn) {
			if p != servicePort {
				return nil
			}
			return func(remote net.Conn) {
				defer remote.Close()
				local, err := net.DialTimeout("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 10*time.Second)
				if err != nil {
					fmt.Fprintf(os.Stderr, "sub2sub service connection: %v\n", err)
					return
				}
				defer local.Close()
				tailcat.ProxyConns(remote, local)
			}
		}
		if err := server.Start(); err != nil {
			return err
		}
		defer server.Close()
		info, err := tailcat.ParseAddr(server.TailcatAddr())
		if err != nil {
			return err
		}
		if len(info.Region) == 1 {
			id.Region = info.Region[0]
		} else if info.RegionID > 0 {
			id.RegionID = info.RegionID
		} else {
			return fmt.Errorf("missing bootstrap relay region")
		}
		data, err = json.Marshal(id)
		if err != nil {
			return err
		}
		temporary := os.Args[2] + ".new"
		if err := os.WriteFile(temporary, data, 0600); err != nil {
			return err
		}
		if err := os.Rename(temporary, os.Args[2]); err != nil {
			return err
		}
		if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"protocol": 1, "address": server.TailcatAddr()}); err != nil {
			return err
		}
		select {}
	case "dial":
		addr := tailcat.Addr(os.Args[2])
		if _, err := tailcat.ParseAddr(addr); err != nil {
			return err
		}
		client := &tailcat.Client{Server: addr, Logf: logf}
		defer client.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		remote, err := client.DialTCPPort(ctx, servicePort)
		if err != nil {
			return err
		}
		defer remote.Close()
		listener, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			return err
		}
		defer listener.Close()
		if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"protocol": 1, "port": listener.Addr().(*net.TCPAddr).Port}); err != nil {
			return err
		}
		listener.(*net.TCPListener).SetDeadline(time.Now().Add(15 * time.Second))
		local, err := listener.Accept()
		if err != nil {
			return err
		}
		defer local.Close()
		listener.Close()
		tailcat.ProxyConns(local, remote)
		return nil
	default:
		return fmt.Errorf("unsupported transport operation")
	}
}
