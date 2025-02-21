package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
)

func main() {
	hoge := os.Getenv("MESSAGE")
	if hoge == "" {
		fmt.Println("MESSAGE environment variable is not set")
		return
	}

	webhookURL := os.Getenv("SLACK_WEBHOOK_URL")
	if webhookURL == "" {
		fmt.Println("SLACK_WEBHOOK_URL environment variable is not set")
		return
	}

	channel := os.Getenv("SLACK_CHANNEL")
	if channel == "" {
		fmt.Println("SLACK_CHANNEL environment variable is not set")
		return
	}

	message := fmt.Sprintf("MESSAGE: %s", hoge)
	err := sendSlackMessage(webhookURL, channel, message)
	if err != nil {
		fmt.Printf("Error sending message to Slack: %v\n", err)
	}
}

func sendSlackMessage(webhookURL, channel, message string) error {
	payload := map[string]string{
		"text":    message,
		"channel": channel,
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	resp, err := http.Post(webhookURL, "application/json", bytes.NewBuffer(payloadBytes))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("non-200 response: %s", resp.Status)
	}

	return nil
}
