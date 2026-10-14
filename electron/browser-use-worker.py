import asyncio
import json
import os
import sys
import re
from urllib.parse import urljoin, urlparse

from browser_use import Agent, BrowserProfile, ChatOpenAI


def send(message):
    sys.stdout.write(json.dumps(message) + '\n')
    sys.stdout.flush()


def open_navigation_in_new_tab(output):
    for action in output.action:
        navigation = getattr(action, 'navigate', None)
        if navigation is not None:
            navigation.new_tab = True


class VerifiedEmail(BaseException):
    pass


class TaskIncomplete(ValueError):
    def __init__(self, message, session):
        super().__init__(message)
        self.session = session


def official_email_on_page(state, origin):
    if not state or not (state.url == origin or state.url.startswith(origin + '/')):
        return None
    for node in state.dom_state.selector_map.values():
        address = email_from_mailto((node.attributes or {}).get('href'), origin)
        if address:
            return address
    return None


def email_from_mailto(href, origin):
    if not isinstance(href, str) or not href.lower().startswith('mailto:'):
        return None
    address = href[7:].split('?', 1)[0].strip()
    domain = urlparse(origin).hostname.removeprefix('www.')
    if re.fullmatch(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+', address) and address.rsplit('@', 1)[1].lower() == domain:
        return address
    return None


async def location_visible_on_page(answer, origin, browser_session):
    matches = re.findall(r'^Suggested saved area: ([^\r\n]+)$', answer, re.I | re.M)
    if len(matches) != 1 or not browser_session:
        return False
    address = ' '.join(matches[0].split()).casefold()
    if len(address) < 3 or len(address) > 300:
        return False
    page = await browser_session.get_current_page()
    if not page:
        return False
    text = await asyncio.wait_for(page.evaluate(
        '(origin) => location.origin === origin ? document.body.innerText.slice(0, 100000) : ""', origin,
    ), timeout=5)
    return address in ' '.join(json.loads(text).split()).casefold()


async def official_email_in_browser(state, origin, browser_session):
    address = official_email_on_page(state, origin)
    if address or not state or not browser_session or not (state.url == origin or state.url.startswith(origin + '/')):
        return address
    page = await browser_session.get_current_page()
    if not page:
        return None
    links = await asyncio.wait_for(page.evaluate(
        '(origin) => location.origin === origin && (location.href === origin || location.href.startsWith(origin + "/")) '
        '? Array.from(document.querySelectorAll("a[href^=\'mailto:\']"), link => link.getAttribute("href")).slice(0, 100) : []',
        origin,
    ), timeout=5)
    for href in json.loads(links):
        address = email_from_mailto(href, origin)
        if address:
            return address
    return None


def task_is_pizza_order(task, origin):
    return origin in ('https://pizzaonline.dominos.co.in', 'https://www.pizzahut.co.in') and task.startswith(
        f'At {origin}, start a delivery order')


def task_is_ticket_order(task, origin):
    return origin == 'https://in.bookmyshow.com' and bool(re.search(r'\b(?:book|buy|get|find|cheapest)\b.*\b(?:tickets?|seats?)\b', task, re.I))


def routine_navigation(state, action, origin):
    if origin != 'https://in.bookmyshow.com':
        return False
    keys = action.get('send_keys')
    if isinstance(keys, dict):
        return keys.get('keys') in ('Escape', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Tab')
    selection = action.get('select_dropdown_option')
    if not isinstance(selection, dict) or type(selection.get('index')) is not int or not state:
        return False
    node = state.dom_state.selector_map.get(selection['index'])
    if not node or node.node_name.lower() != 'select' or not isinstance(selection.get('text'), str):
        return False
    if not selection['text'].strip() or len(selection['text']) > 80 or re.search(r'payment|checkout|seat|card|address|phone|email', selection['text'], re.I):
        return False
    current = node
    while current:
        if current.node_name.lower() == 'form' or re.search(r'payment|checkout|seat|card|address|phone|email',
                ' '.join(str(value) for value in (current.attributes or {}).values()), re.I):
            return False
        current = current.parent_node
    return True


def routine_click(state, action, origin):
    params = action.get('click')
    if not isinstance(params, dict) or type(params.get('index')) is not int or not state:
        return False
    node = state.dom_state.selector_map.get(params['index'])
    if not node:
        return False
    attributes = node.attributes or {}
    label = ' '.join(str(value) for value in (
        node.ax_node.name if node.ax_node else '',
        attributes.get('aria-label', ''), attributes.get('title', ''),
        attributes.get('value', ''), attributes.get('name', ''),
    ))
    bookmyshow = origin == 'https://in.bookmyshow.com'
    showtime = bookmyshow and node.node_name.lower() == 'button' and bool(re.fullmatch(r'Book\s+\d{1,2}:\d{2}\s*[AP]M', label.strip(), re.I))
    text = node.get_meaningful_text_for_llm().strip() if bookmyshow else ''
    if bookmyshow and (re.fullmatch(r'[A-Z]{1,3}[- ]?\d{1,3}', text) or re.search(r'\b(pay|purchase|checkout|confirm|proceed|seat|login|sign.?in)\b', text, re.I)):
        return False
    if not showtime and re.search(r'\b(submit|send|pay|purchase|buy|checkout|order|delete|remove|save|upload|download|register|sign.?up|log.?in|subscribe|authorize|confirm|publish|post|transfer|book|apply|accept|agree)\b', label, re.I):
        return False
    if origin == 'https://www.irctc.co.in' and node.node_name.lower() in ('li', 'div', 'span', 'strong'):
        current = node
        for _ in range(4):
            if current.node_name.lower() == 'li':
                option_attrs = current.attributes or {}
                if option_attrs.get('role') == 'option' and 'ui-autocomplete-list-item' in option_attrs.get('class', '').split():
                    options = current.parent_node
                    panel = options.parent_node if options else None
                    wrapper = panel.parent_node if panel else None
                    widget = wrapper.parent_node if wrapper else None
                    if (options and options.node_name.lower() == 'ul' and (options.attributes or {}).get('role') == 'listbox'
                            and 'ui-autocomplete-items' in (options.attributes or {}).get('class', '').split()
                            and panel and 'ui-autocomplete-panel' in (panel.attributes or {}).get('class', '').split()
                            and wrapper and 'ui-autocomplete' in (wrapper.attributes or {}).get('class', '').split()
                            and widget and widget.node_name.lower() == 'p-autocomplete'
                            and (widget.attributes or {}).get('id') in ('origin', 'destination')):
                        return bool(re.search(r' - [A-Z0-9]{2,5}\b', current.get_meaningful_text_for_llm()))
                break
            if current.node_name.lower() not in ('div', 'span', 'strong'):
                break
            current = current.parent_node
            if current is None:
                break
    irctc_option = (node.node_name.lower() == 'li' and attributes.get('role') == 'option'
                    and 'ui-dropdown-item' in attributes.get('class', '').split())
    if origin == 'https://www.irctc.co.in' and (node.node_name.lower() in ('div', 'span') or irctc_option):
        current = node
        for _ in range(8):
            if current.node_name.lower() == 'p-dropdown':
                return (current.attributes or {}).get('id') in ('journeyClass', 'journeyQuota')
            if current.node_name.lower() not in ('div', 'span', 'li', 'p-dropdownitem', 'ul') or re.search(r'payment|checkout|captcha|login|submit',
                    ' '.join(str(value) for value in (current.attributes or {}).values()), re.I):
                break
            current = current.parent_node
            if current is None:
                break
    current = node
    while current:
        tag = current.node_name.lower()
        if tag == 'form' or tag in ('input', 'textarea', 'select'):
            return False
        if (current.attributes or {}).get('form'):
            return False
        if tag == 'button' and (current.attributes or {}).get('type', '').lower() == 'submit':
            return False
        if bookmyshow and current is not node and re.search(r'checkout|payment|seat|cart',
                ' '.join(str((current.attributes or {}).get(key, '')) for key in ('id', 'class', 'role')), re.I):
            return False
        if tag == 'a' and (current.attributes or {}).get('href'):
            target = urlparse(urljoin(origin, current.attributes['href']))
            return target.scheme == 'https' and target.netloc == urlparse(origin).netloc and not target.username and not target.password
        current = current.parent_node
    if showtime:
        return True
    if origin == 'https://in.bookmyshow.com':
        if re.search(r'\b(pay|purchase|checkout|confirm|proceed|seat|book|login|sign.?in)\b', text, re.I) or re.fullmatch(r'[A-Z]{1,3}[- ]?\d{1,3}', text):
            return False
        if node.node_name.lower() == 'li' and 0 < len(text) <= 80:
            return True
        if node.node_name.lower() == 'div' and text == 'Search for Movies, Events, Plays, Sports and Activities':
            return True
        if node.node_name.lower() == 'button' and label.strip() and not re.search(r'\b(pay|purchase|checkout|confirm|proceed|seat|book|login|sign.?in)\b', label, re.I):
            return True
    if attributes.get('role', '').lower() == 'tab' and label.strip():
        return True
    return (node.node_name.lower() == 'button' and attributes.get('type', '').lower() == 'button'
        and bool(re.match(r'^(show|hide|expand|collapse|more|less|next|previous|menu|open menu|close menu|details)(\b|$)', label.strip(), re.I)))


def routine_input(state, action, origin=''):
    params = action.get('input')
    if not isinstance(params, dict) or type(params.get('index')) is not int or not state:
        return False
    text = params.get('text')
    if not isinstance(text, str) or not text.strip() or len(text) > 160 or re.search(r'[@\r\n]|\b\d[\d\s()+.-]{7,}\d\b', text):
        return False
    node = state.dom_state.selector_map.get(params['index'])
    if not node or node.node_name.lower() != 'input':
        return False
    attributes = node.attributes or {}
    label = ' '.join(str(value) for value in (attributes.get('name', ''), attributes.get('id', ''), attributes.get('aria-label', ''), attributes.get('placeholder', '')))
    if re.search(r'password|email|phone|address|card|payment|login|sign.?in|contact', label, re.I):
        return False
    if attributes.get('type', '').lower() == 'search' or attributes.get('role', '').lower() == 'searchbox':
        return True
    parent = getattr(node, 'parent_node', None)
    container = getattr(parent, 'parent_node', None) if parent else None
    return (origin == 'https://in.bookmyshow.com' and attributes.get('type', '').lower() == 'text'
        and parent is not None and container is not None
        and 'sc-10a0gyl-4' in (parent.attributes or {}).get('class', '').split()
        and 'sc-10a0gyl-1' in (container.attributes or {}).get('class', '').split())


def contact_field(state, action):
    params = action.get('input')
    if not isinstance(params, dict) or type(params.get('index')) is not int or not state:
        return None
    node = state.dom_state.selector_map.get(params['index'])
    if not node or node.node_name.lower() not in ('input', 'textarea'):
        return None
    attributes = node.attributes or {}
    label = ' '.join(str(value) for value in (node.ax_node.name if node.ax_node else '',
        attributes.get('name', ''), attributes.get('id', ''), attributes.get('aria-label', ''), attributes.get('placeholder', '')))
    if re.search(r'password|card|payment|cvv|otp|security|login|sign.?in|account', label, re.I):
        return None
    current = node.parent_node
    while current:
        if current.node_name.lower() == 'form' and re.search(r'login|sign.?in|checkout|payment|account|password',
                ' '.join(str(value) for value in (current.attributes or {}).values()), re.I):
            return None
        current = current.parent_node
    field_type = attributes.get('type', '').lower()
    if field_type in ('password', 'hidden', 'number'):
        return None
    for field, pattern in (('email', r'\be-?mail\b'), ('phone', r'\b(?:phone|mobile|telephone)\b'),
                           ('address', r'\b(?:address|street)\b'), ('name', r'\b(?:(?:full|first|last|your|contact)[\s_-]+name|name)\b')):
        if re.search(pattern, label, re.I) or field_type == field:
            return field
    return None


def captcha_action(state, output):
    if not state or not output.action:
        return False
    action = output.action[0].model_dump(exclude_none=True)
    name = next(iter(action), '')
    if name not in ('click', 'input', 'done'):
        return False
    nodes = state.dom_state.selector_map
    index = action.get(name, {}).get('index') if name != 'done' else None
    candidates = [nodes.get(index)] if type(index) is int else nodes.values() if name == 'done' else []
    for node in candidates:
        current = node
        for _ in range(4):
            if not current:
                break
            attributes = current.attributes or {}
            markers = ' '.join(str(attributes.get(key, '')) for key in ('id', 'class', 'aria-label', 'title', 'name'))
            if re.search(r'captcha|recaptcha|hcaptcha|turnstile|image challenge|verify you are human', markers, re.I):
                return True
            current = current.parent_node
        if node and re.search(r'captcha|image challenge|verify you are human', node.get_meaningful_text_for_llm()[:120], re.I):
            return True
    return False


async def review_action(state, output, number, origin):
    action = output.action[0].model_dump(exclude_none=True) if output.action else {}
    name = next(iter(action), 'unknown')
    if name == 'done':
        return
    field = contact_field(state, action) if name == 'input' else None
    detail = action.copy()
    if name in ('click', 'input') and state and isinstance(action.get(name), dict):
        index = action[name].get('index')
        node = state.dom_state.selector_map.get(index) if type(index) is int else None
        if node:
            attributes = node.attributes or {}
            label = (node.ax_node.name if node.ax_node else '') or attributes.get('aria-label') or attributes.get('placeholder') or attributes.get('title') or node.get_meaningful_text_for_llm()
            detail = {name: {**action[name], 'element': node.node_name.lower(), 'label': str(label)[:120], 'type': attributes.get('type', '')}}
            if name == 'input':
                detail[name]['context'] = ' '.join(str((parent.attributes or {}).get('class', '')) for parent in (node.parent_node, node.parent_node.parent_node if node.parent_node else None) if parent)[:120]
            if name == 'click' and not label:
                detail[name]['context'] = ' '.join(
                    f"{parent.node_name.lower()} " + ' '.join(str((parent.attributes or {}).get(key, '')) for key in ('aria-label', 'title', 'id', 'class'))
                    for parent in (node, node.parent_node, node.parent_node.parent_node if node.parent_node else None) if parent
                )[:180]
    send({'type': 'approval', 'step': number, 'action': name, 'detail': json.dumps(detail)[:1000], 'origin': origin,
            'routine_click': (name == 'click' and routine_click(state, action, origin)) or routine_navigation(state, action, origin),
            'routine_input': name == 'input' and routine_input(state, action, origin), **({'field': field} if field else {})})
    response = json.loads(await asyncio.to_thread(sys.stdin.readline))
    if response.get('allow') is not True:
        raise asyncio.CancelledError('Browser action denied')
    if field:
        value = response.get('text')
        if not isinstance(value, str) or not value.strip() or len(value) > 300:
            raise asyncio.CancelledError('Contact field value missing')
        output.action[0].input.text = value


async def main(request=None, browser_session=None):
    if request is None:
        request = json.loads(sys.stdin.readline())
    if request['provider'] == 'zai':
        endpoint, model = 'https://api.z.ai/api/paas/v4', 'glm-5'
    elif request['provider'] == 'bedrock-mantle':
        endpoint, model = 'https://bedrock-mantle.ap-south-1.api.aws/v1', 'zai.glm-5'
    else:
        raise ValueError('Unsupported GLM-5 provider')

    llm = ChatOpenAI(
        model=model, api_key=os.environ['JARVIS_BROWSER_KEY'], base_url=endpoint,
        temperature=0.2, frequency_penalty=None, max_completion_tokens=None,
        add_schema_to_system_prompt=True, dont_force_structured_output=True,
    )
    payment_handoff = task_is_pizza_order(request['task'], request['origin']) or task_is_ticket_order(request['task'], request['origin'])
    profile = BrowserProfile(
        executable_path=request['chrome'], headless=False, user_data_dir=None, keep_alive=True,
        allowed_domains=[request['origin']], block_ip_addresses=True,
        accept_downloads=False, permissions=[], enable_default_extensions=False,
    )
    location_granted = False

    async def approve_step(state, output, number):
        nonlocal location_granted
        if request.get('allow_location') and not location_granted:
            await agent.browser_session.cdp_client.send.Browser.grantPermissions(
                params={'permissions': ['geolocation'], 'origin': request['origin']})
            location_granted = True
        open_navigation_in_new_tab(output)
        if re.search(r'\b(?:email|e-mail)\b', request['task'], re.I):
            address = await official_email_in_browser(state, request['origin'], getattr(agent, 'browser_session', None))
            if address:
                raise VerifiedEmail(address)
        action = output.action[0].model_dump(exclude_none=True) if output.action else {}
        done = action.get('done')
        question = done.get('text', '').strip() if isinstance(done, dict) else ''
        needs_reply = question.endswith('?') or (isinstance(done, dict) and done.get('success') is False
            and re.search(r'\b(?:choose|provide|specify|tell me|which|need your|reply with)\b', question, re.I))
        page_url = getattr(state, 'url', None)
        handoff_url = request['origin'] if page_url == 'about:blank' else page_url
        target = urlparse(handoff_url) if isinstance(handoff_url, str) else None
        approved = urlparse(request['origin'])
        if needs_reply and len(question) <= 700 and target and target.scheme == approved.scheme and target.netloc == approved.netloc:
            send({'type': 'approval', 'step': number, 'action': 'question_handoff',
                  'detail': json.dumps({'question_handoff': {'question': question, 'url': handoff_url}}),
                  'origin': request['origin'], 'routine_click': False, 'routine_input': False})
            response = json.loads(await asyncio.to_thread(sys.stdin.readline))
            reply = response.get('text')
            if response.get('allow') is not True or not isinstance(reply, str) or not reply.strip() or len(reply) > 1000:
                raise asyncio.CancelledError('Question handoff cancelled')
            agent.message_manager.add_new_task(reply.strip())
            output.action = [type(output.action[0]).model_validate({'wait': {'seconds': 1}})]
            return
        if captcha_action(state, output):
            send({'type': 'approval', 'step': number, 'action': 'captcha_handoff',
                  'detail': json.dumps({'captcha_handoff': {'url': state.url}}), 'origin': request['origin'],
                  'routine_click': False, 'routine_input': False})
            response = json.loads(await asyncio.to_thread(sys.stdin.readline))
            if response.get('allow') is not True:
                raise asyncio.CancelledError('CAPTCHA handoff cancelled')
            output.action = [type(output.action[0]).model_validate({'wait': {'seconds': 1}})]
            return
        await review_action(state, output, number, request['origin'])

    details = request.get('details')
    task = request['task']
    if re.search(r'\b(?:email|e-mail)\b', task, re.I):
        task += '\nFor this email lookup, read the page text and mailto links first. If you directly observe the email address, report it without clicking the address or opening an email client.'
    if details:
        task += '\nUser explicitly approved sharing these contact details for this task only. Use them only for fields that match: ' + json.dumps(details)
    agent = Agent(
        task=task, llm=llm, browser_profile=profile, browser_session=browser_session,
        register_new_step_callback=approve_step, max_actions_per_step=1,
        max_failures=2, use_vision=False, use_judge=False, step_timeout=24 * 60 * 60,
        enable_signal_handler=False, directly_open_url=False,
    )
    send({'type': 'status', 'text': 'Browser-use is preparing Chrome and its first action.'})
    try:
        try:
            history = await agent.run(max_steps=40)
        except VerifiedEmail as verified:
            send({'type': 'result', 'text': f'Official email: {verified} (source: {request["origin"]})'})
            return getattr(agent, 'browser_session', browser_session)
        if not history.is_done():
            session = getattr(agent, 'browser_session', browser_session)
            if session is None:
                raise ValueError('Browser-use did not complete the task after 40 steps. No Chrome session is available to inspect.')
            raise TaskIncomplete('Browser-use did not complete the task after 40 steps. Inspect Chrome and retry with a narrower request.', session)
        if history.is_successful() is not True:
            reason = (history.final_result() or '').strip().replace('\n', ' ')[:120]
            session = getattr(agent, 'browser_session', browser_session)
            if re.search(r'\b(?:book|buy|reserve)\b.*\b(?:train|express|railway)\b', request['task'], re.I):
                reason = 'A schedule or seat-availability summary is not a confirmed train ticket. No booking was verified'
            if session is not None:
                raise TaskIncomplete(f'Browser-use could not verify the task: {reason or "the site did not provide a result"}. Inspect Chrome and retry.', session)
            raise ValueError(f'Browser-use could not verify the task: {reason or "the site did not provide a result"}.')
        if not any(url and (url == request['origin'] or url.startswith(request['origin'] + '/')) for url in history.urls()):
            raise ValueError('Browser-use did not observe the requested site')
        answer = (history.final_result() or '').strip()
        if not answer:
            raise ValueError('Browser-use returned no answer')
        if request.get('allow_location') and not await location_visible_on_page(answer, request['origin'], getattr(agent, 'browser_session', None)):
            raise TaskIncomplete('Precise location was not visible on the approved site. An IP-based estimate is not your device location. Inspect Chrome and retry.', getattr(agent, 'browser_session', browser_session))
        if payment_handoff:
            send({'type': 'approval', 'step': 41, 'action': 'payment_handoff', 'detail': json.dumps({'payment_handoff': {'status': answer[:500]}}),
                  'origin': request['origin'], 'routine_click': False, 'routine_input': False})
            response = json.loads(await asyncio.to_thread(sys.stdin.readline))
            if response.get('allow') is not True:
                raise asyncio.CancelledError('Payment handoff cancelled')
        send({'type': 'result', 'text': answer[:4000]})
        return getattr(agent, 'browser_session', browser_session)
    except BaseException as error:
        session = getattr(agent, 'browser_session', browser_session)
        if session is not None and not isinstance(error, TaskIncomplete):
            await session.kill()
        raise


async def serve():
    browser_session = None
    origin = None
    try:
        while line := await asyncio.to_thread(sys.stdin.readline):
            request = json.loads(line)
            if origin is not None and request['origin'] != origin:
                raise ValueError('Browser-use worker cannot change its approved origin')
            try:
                browser_session = await main(request, browser_session)
            except TaskIncomplete as error:
                browser_session = error.session
                origin = request['origin']
                send({'type': 'task_failed', 'message': str(error)[:200]})
            origin = request['origin']
            send({'type': 'ready'})
    finally:
        if browser_session is not None:
            await browser_session.kill()


if __name__ == '__main__':
    try:
        asyncio.run(serve())
    except asyncio.CancelledError:
        send({'type': 'error', 'message': 'Browser action denied.'})
    except ValueError as error:
        send({'type': 'error', 'message': str(error)[:200]})
    except Exception as error:
        send({'type': 'error', 'message': f'Browser-use failed ({type(error).__name__}). Check the local runtime and GLM-5 provider compatibility.'})