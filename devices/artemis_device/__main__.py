from .cli import main

try:
    main()
except KeyboardInterrupt:
    print('Disconnected.', flush=True)
