import requests

url = "https://api.deepseek.com/chat/completions"
headers = {"Authorization": "Bearer 你的key"}
messages = []

while True:
    messages.append({"role": "user", "content": input("你: ")})
    r = requests.post(url, headers=headers,
                      json={"model": "deepseek-chat", "messages": messages}).json()
    reply = r["choices"][0]["message"]["content"]
    messages.append({"role": "assistant", "content": reply})
    print("AI:", reply)