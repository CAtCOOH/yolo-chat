from openai import OpenAI

client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")

messages = []
while True:
    messages.append({"role": "user", "content": input("你: ")})
    r = client.chat.completions.create(model="qwen2.5:7b", messages=messages)
    reply = r.choices[0].message.content
    messages.append({"role": "assistant", "content": reply})
    print("AI:", reply)